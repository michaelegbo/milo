import { codexModel, codexStatus, companionRequest, disconnectCompanion, pairCompanion, refreshCodex, selectCodexModel, selectReplyProvider, usesCodex } from './reply-provider';

export function createCodexPanel(container: HTMLElement, onStop: () => void) {
  container.innerHTML = `<div class="conversation-model"><label for="reply-provider">REPLY PROVIDER</label><select id="reply-provider"><option value="device">On this device · Private</option><option value="codex">ChatGPT · My account</option></select><span>Voice and listening stay on your device.</span></div>
    <div id="codex-controls" class="codex-controls" hidden><p>ChatGPT receives your messages and conversation context to generate replies. Uses your account’s Codex allowance.</p>
    <details id="codex-setup"><summary>Connect your computer</summary><p>Requires the Milo companion and Codex CLI on Windows, macOS, or Linux. This option is not available directly on phones.</p><p>In Milo’s folder, run <code>npm run codex:bridge</code>, then paste the pairing code below. Keep the companion running.</p><a href="https://github.com/michaelegbo/milo/blob/main/docs/chatgpt-companion.md" target="_blank" rel="noopener noreferrer">Companion setup guide ↗</a></details>
    <form id="codex-pair-form"><label for="codex-pairing">Companion pairing code</label><div class="codex-pair-row"><input id="codex-pairing" type="password" autocomplete="off" spellcheck="false" maxlength="64" placeholder="From your companion terminal"><button class="text-button" type="submit">Connect</button></div></form>
    <div class="codex-actions"><button id="codex-login" class="text-button" hidden>Sign in to ChatGPT ↗</button><a id="codex-auth-link" target="_blank" rel="noopener noreferrer" hidden>Continue sign-in ↗</a><button id="codex-cancel-login" class="text-button" hidden>Cancel sign-in</button><button id="codex-refresh" class="text-button">Check connection</button><button id="codex-logout" class="text-button" hidden>Sign out of ChatGPT</button><button id="codex-disconnect" class="text-button">Disconnect</button></div>
    <div id="codex-model-field" class="conversation-model" hidden><label for="codex-model">CHATGPT MODEL</label><select id="codex-model"></select></div><p id="codex-status" role="status">Connect your companion to sign in.</p></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  let busy = false, disposed = false, message = '', authUrl = '';
  const select = el<HTMLSelectElement>('reply-provider');
  function render() {
    const status = codexStatus();
    select.value = usesCodex() ? 'codex' : 'device';
    el('codex-controls').hidden = !usesCodex();
    el('codex-pair-form').hidden = !!status?.connected;
    el('codex-login').hidden = !status?.connected || !!status.signedIn || !!status.loginPending;
    el('codex-logout').hidden = !status?.signedIn;
    el('codex-cancel-login').hidden = !status?.loginPending;
    const link = el<HTMLAnchorElement>('codex-auth-link');
    link.hidden = !authUrl || !status?.loginPending;
    if (authUrl) link.href = authUrl; else link.removeAttribute('href');
    el('codex-model-field').hidden = !status?.signedIn;
    const models = el<HTMLSelectElement>('codex-model');
    if (JSON.stringify([...models.options].map(o => o.value)) !== JSON.stringify(status?.models.map(m => m.id) ?? [])) models.replaceChildren(...(status?.models ?? []).map(m => new Option(m.name, m.id)));
    models.value = codexModel(); models.disabled = busy;
    container.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
    select.disabled = false; // Returning to local mode is always possible.
    el('codex-status').textContent = message || status?.loginError || (status?.signedIn ? `ChatGPT connected${status.plan ? ` · ${status.plan}` : ''}. ${status.models.length ? 'Choose a model and start Milo’s voice above.' : 'No models available for this account.'}` : status?.loginPending ? 'Finish sign-in in the OpenAI tab, then return here.' : status?.connected ? 'Companion connected. Sign in to ChatGPT to continue.' : 'Connect your companion to sign in.');
  }
  async function run(action: () => Promise<void>, quiet = false) {
    if (busy) return;
    busy = true; if (!quiet) { message = 'Connecting…'; render(); }
    try { await action(); message = ''; }
    catch (error) { message = error instanceof Error ? error.message : 'Connection failed. Try again.'; }
    finally { busy = false; if (!disposed) render(); }
  }
  select.addEventListener('change', () => {
    onStop(); message = ''; authUrl = '';
    selectReplyProvider(select.value === 'codex' ? 'codex' : 'device'); render();
    if (usesCodex()) el<HTMLDetailsElement>('codex-setup').open = !codexStatus()?.connected;
  });
  el('codex-pair-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => { pairCompanion(el<HTMLInputElement>('codex-pairing').value); el<HTMLInputElement>('codex-pairing').value = ''; await refreshCodex(); el<HTMLDetailsElement>('codex-setup').open = false; });
  });
  el('codex-refresh').addEventListener('click', () => void run(refreshCodex));
  el('codex-login').addEventListener('click', () => void run(async () => {
    const result = await (await companionRequest('/login', {})).json();
    const url = new URL(result.authUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) throw new Error('Unrecognized sign-in address. Update the companion.');
    authUrl = result.authUrl;
    // A real link works even when cross-origin isolation severs popup references.
    window.open(authUrl, '_blank', 'noopener,noreferrer');
    await refreshCodex();
  }));
  el('codex-cancel-login').addEventListener('click', () => void run(async () => { await companionRequest('/login/cancel', {}); authUrl = ''; await refreshCodex(); }));
  el('codex-logout').addEventListener('click', () => { onStop(); void run(async () => { await companionRequest('/logout', {}); authUrl = ''; await refreshCodex(); }); });
  el('codex-disconnect').addEventListener('click', () => { onStop(); authUrl = ''; message = ''; disconnectCompanion(); render(); });
  el('codex-model').addEventListener('change', () => { onStop(); selectCodexModel(el<HTMLSelectElement>('codex-model').value); window.dispatchEvent(new Event('milo-device-change')); });
  const timer = setInterval(() => { if (usesCodex() && codexStatus()?.connected && !busy) void run(refreshCodex, true); }, 5000);
  window.addEventListener('milo-device-change', render);
  render();
  return { dispose() { disposed = true; clearInterval(timer); window.removeEventListener('milo-device-change', render); } };
}

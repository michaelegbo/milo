import { codexModel, codexStatus, codexRequest, disconnectCodex, refreshCodex, selectCodexModel, selectReplyProvider, updateCodexStatus, usesCodex } from './reply-provider';

export function createCodexPanel(container: HTMLElement, onStop: () => void) {
  container.innerHTML = `<div class="conversation-model"><label for="reply-provider">REPLY PROVIDER</label><select id="reply-provider"><option value="device">On this device · Private</option><option value="codex">ChatGPT · My account</option></select><span>Voice and listening stay on your device.</span></div>
    <div id="codex-controls" class="codex-controls" hidden><p>Use your own ChatGPT account. Messages and conversation context pass through Milo to OpenAI. Uses your account’s Codex allowance.</p>
    <div id="codex-device-login" hidden><p>Enter this one-time code on OpenAI’s page.</p><div class="codex-code-row"><strong id="codex-device-code" aria-label="OpenAI one-time code"></strong><button id="codex-copy-code" class="text-button">Copy code</button></div><a id="codex-auth-link" class="primary-button" target="_blank" rel="noopener noreferrer">Open OpenAI ↗</a><p id="codex-waiting" role="status">Waiting for OpenAI…</p><p class="codex-code-help">If OpenAI asks, enable device-code sign-in in your ChatGPT security settings.</p></div>
    <div class="codex-actions"><button id="codex-login" class="primary-button">Connect ChatGPT ↗</button><button id="codex-new-code" class="text-button" hidden>Get a new code</button><button id="codex-cancel-login" class="text-button" hidden>Cancel sign-in</button><button id="codex-refresh" class="text-button">Check connection</button><button id="codex-logout" class="text-button" hidden>Disconnect ChatGPT</button></div>
    <div id="codex-model-field" class="conversation-model" hidden><label for="codex-model">CHATGPT MODEL</label><select id="codex-model"></select></div><p id="codex-status" role="status">Connect your ChatGPT account to get started.</p></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  let busy = false, disposed = false, message = '';
  const select = el<HTMLSelectElement>('reply-provider');
  function render() {
    const status = codexStatus(), login = status?.login;
    select.value = usesCodex() ? 'codex' : 'device';
    el('codex-controls').hidden = !usesCodex();
    el('codex-login').hidden = !!status?.signedIn || !!login;
    el('codex-logout').hidden = !status?.signedIn;
    el('codex-cancel-login').hidden = !login;
    el('codex-new-code').hidden = !login;
    el('codex-device-login').hidden = !login;
    el('codex-device-code').textContent = login?.userCode || '';
    const link = el<HTMLAnchorElement>('codex-auth-link');
    if (login?.verificationUrl === 'https://auth.openai.com/codex/device') link.href = login.verificationUrl; else link.removeAttribute('href');
    if (login) el('codex-waiting').textContent = `Waiting for OpenAI… Code expires in about ${Math.max(0, Math.ceil((login.expiresAt - Date.now()) / 60000))} minutes.`;
    el('codex-model-field').hidden = !status?.signedIn;
    const models = el<HTMLSelectElement>('codex-model');
    if (JSON.stringify([...models.options].map(o => o.value)) !== JSON.stringify(status?.models.map(m => m.id) ?? [])) models.replaceChildren(...(status?.models ?? []).map(m => new Option(m.name, m.id)));
    models.value = codexModel(); models.disabled = busy;
    container.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
    el('codex-status').textContent = message || status?.loginError || (status?.signedIn ? `ChatGPT connected${status.plan ? ` · ${status.plan}` : ''}. ${status.models.length ? 'Choose a model. Prepare Milo’s voice above when needed.' : 'No models available for this account.'}` : login ? 'Complete sign-in on OpenAI’s page. Milo connects automatically when you return.' : 'Connect your ChatGPT account to get started. No installation needed.');
  }
  async function run(action: () => Promise<void>, quiet = false) {
    if (busy) return;
    busy = true; if (!quiet) { message = 'Checking your connection…'; render(); }
    try { await action(); message = ''; }
    catch (error) { message = error instanceof Error ? error.message : 'Connection failed. Try again.'; }
    finally { busy = false; if (!disposed) render(); }
  }
  select.addEventListener('change', () => {
    const value = select.value; onStop(); message = '';
    selectReplyProvider(value === 'codex' ? 'codex' : 'device'); render();
    if (usesCodex()) void run(refreshCodex, true);
  });
  el('codex-refresh').addEventListener('click', () => void run(refreshCodex));
  const startLogin = async () => {
    const result = await (await codexRequest('/login', {})).json();
    if (result.login && (result.login.verificationUrl !== 'https://auth.openai.com/codex/device' || !/^[A-Za-z0-9-]{4,32}$/.test(result.login.userCode))) throw new Error('OpenAI sign-in could not be started. Please retry.');
    updateCodexStatus(result); el('codex-copy-code').textContent = 'Copy code';
  };
  el('codex-login').addEventListener('click', () => void run(startLogin));
  el('codex-new-code').addEventListener('click', () => void run(async () => { await codexRequest('/login/cancel', {}); await startLogin(); }));
  el('codex-copy-code').addEventListener('click', () => {
    const code = codexStatus()?.login?.userCode; if (!code) return;
    void Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(() => { el('codex-copy-code').textContent = 'Copied'; }).catch(() => { message = 'Select and copy the code manually, then open OpenAI.'; render(); });
  });
  el('codex-cancel-login').addEventListener('click', () => void run(async () => { await codexRequest('/login/cancel', {}); await refreshCodex(); }));
  el('codex-logout').addEventListener('click', () => { onStop(); void run(async () => { await codexRequest('/logout', {}); disconnectCodex(); }); });
  el('codex-model').addEventListener('change', () => { const value = el<HTMLSelectElement>('codex-model').value; onStop(); selectCodexModel(value); window.dispatchEvent(new Event('milo-device-change')); });
  const timer = setInterval(() => { if (usesCodex() && (codexStatus()?.loginPending || codexStatus()?.signedIn) && !busy) void run(refreshCodex, true); }, 3000);
  window.addEventListener('milo-device-change', render); render();
  return {
    /** Start sign-in from elsewhere in the panel, or bring the controls into view when sign-in is already underway. */
    login() {
      const button = el<HTMLButtonElement>('codex-login');
      if (!button.hidden && !button.disabled) button.click();
      else container.scrollIntoView({ block: 'center' });
    },
    dispose() { disposed = true; clearInterval(timer); window.removeEventListener('milo-device-change', render); },
  };
}

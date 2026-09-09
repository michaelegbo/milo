import { apiFetch } from './transport';
import { isDeviceOnly } from './deployment';
import { codexStatus, usesCodex } from './reply-provider';
import { usesHostedVoice, voiceLabel } from './voice-provider';
import { createCodexPanel } from './codex-panel';
import { MicrophoneRecorder } from './microphone';
import type { SpeechPlayer } from './speech';
import { readReplyStream, rememberExplicitFacts, type ChatMessage as Message, type ConversationMemory } from './conversation-memory';

type State = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'voicing' | 'speaking' | 'error';
type ChatMode = 'fast' | 'quality' | 'hybrid';
type ReplyRoute = { profile: 'fast' | 'quality'; reason: string };
type Acceleration = { available: boolean; enabled: boolean; status: 'detecting' | 'ready' | 'switching' | 'unavailable' | 'error'; backend: 'vulkan' | 'cuda' | 'webgpu' | null; deviceName: string | null; deviceInfo?: string | null; message: string; revision: number };
type Engine = { status: string; progress?: number; message?: string; profile?: string; queueDepth?: number; selectedModel?: string | null; residency?: 'dual' | 'single'; residencyReason?: string; device?: 'cpu' | 'gpu' | null; acceleration?: Acceleration; residentModels?: Record<string, { status: string; device?: 'cpu' | 'gpu' | null }> };
type Health = { stt: Engine; chat: Engine; tts: Engine };
const labels: Record<State, string> = { idle: 'Ready to talk', listening: 'Listening to you', transcribing: 'Hearing your words', thinking: 'Milo is thinking', voicing: 'Finding Milo’s voice', speaking: 'Milo is speaking', error: 'Let’s try again' };

export function createConversation(options: {
  container: HTMLElement; player: SpeechPlayer;
  getVoice: () => { voice: string; speed: number };
  setVoice: (voice: string) => void;
  onSpeech: (text: string) => void;
  onStateChange: () => void;
  /** Browser edition only: the setup panel's consent action and what it would do. */
  device?: { start(): void; describe(): { supported: boolean; capability: string; saved: 'all' | 'some' | 'none' | 'unknown'; busy: boolean; size: string } };
}) {
  const { container, player } = options;
  container.innerHTML = `
    <div class="panel-heading"><div><span class="eyebrow">A TWO-WAY CONVERSATION</span><h2 id="conversation-heading">Hello again, human.</h2></div><button id="new-conversation" class="text-button" title="Clear this conversation">New chat</button></div>
    <div id="conversation-engines" class="conversation-engines" role="status">Preparing your local conversation…</div>
    <div id="conversation-next" class="conversation-next" role="region" aria-labelledby="conversation-next-heading" hidden><span id="conversation-next-heading" class="eyebrow">BEFORE WE TALK</span><p id="conversation-next-text"></p><button id="conversation-next-action" class="primary-button" type="button" hidden></button></div>
    <div class="conversation-model"><label for="conversation-model">MILO’S MIND</label><select id="conversation-model"><option value="fast">Fast · Qwen 1.5B</option><option value="quality">Better answers · Qwen 4B</option><option value="hybrid">Hybrid · Adapts to you</option></select><span id="model-hint">Quick, everyday conversation.</span><div id="conversation-route" class="conversation-route" role="status" hidden><span id="route-label">Chooses for each reply</span><span id="route-reason">Simple chat stays quick. Complex questions get more thought.</span></div></div>
    <div class="conversation-acceleration"><div><span class="gpu-heading">GPU acceleration</span><span id="gpu-device">Checking compatible hardware…</span></div><button id="gpu-toggle" class="gpu-toggle" role="switch" aria-label="GPU acceleration" aria-checked="false" aria-describedby="gpu-status gpu-details" disabled><span class="switch" aria-hidden="true"></span><span id="gpu-toggle-label">Off</span></button><p id="gpu-status" role="status">Checking for a GPU…</p><span id="gpu-details" class="gpu-scope" hidden></span><span class="gpu-scope">Replies only · speech stays on CPU</span></div>
    <div class="conversation-log" id="conversation-log" role="log" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions" tabindex="0"><div id="conversation-empty" class="conversation-empty"><span class="conversation-spark" aria-hidden="true">✳</span><h3>A voice on the other side.</h3><p>Tell Milo about your day, ask a question,<br>or just say hello.</p><span>Your conversation stays in this tab.</span></div></div>
    <div class="conversation-feedback"><span class="conversation-light" aria-hidden="true"></span><p id="conversation-status" role="status">Start talking, or send a little note below.</p></div>
    <div class="mic-controls">
      <div class="mic-device"><label for="mic-device">MICROPHONE</label><div class="mic-input"><select id="mic-device" aria-label="Microphone input"><option value="">System default</option></select><button id="mic-refresh" aria-label="Refresh microphones" title="Refresh microphones"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button></div></div>
      <button id="mic-toggle" class="mic-toggle" aria-label="Mute microphone" aria-pressed="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/><path class="mic-slash" d="m3 3 18 18"/></svg><span id="mic-toggle-label">Mute mic</span></button>
      <div class="mic-readout"><span id="mic-state" role="status">Mic idle</span><div id="mic-meter" class="mic-input-meter" role="meter" aria-label="Microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="mic-level"></i></div></div>
    </div>
    <div class="conversation-controls"><button id="conversation-start" class="primary-button" disabled>Start conversation</button><button id="conversation-end" class="stop-button" disabled aria-label="End conversation" title="End conversation">■</button></div>
    <div class="conversation-preferences"><label><input id="conversation-loop" type="checkbox" checked> Keep listening after each reply</label><label class="sr-only" for="conversation-voice">Conversation voice</label><select id="conversation-voice" aria-label="Conversation voice"><option value="am_michael">Michael</option><option value="af_heart">Heart</option><option value="bf_emma">Emma</option></select></div>
    <label class="conversation-interruption"><input id="conversation-interrupt" type="checkbox" checked> Interrupt Milo by speaking <span>During voice conversations · headphones work best</span></label>
    <form id="conversation-form" class="conversation-composer"><label class="sr-only" for="conversation-input">Message Milo</label><input id="conversation-input" type="text" maxlength="1000" placeholder="Or type something to Milo…" autocomplete="off"><button id="conversation-send" type="submit" aria-label="Send message" disabled>Send ↗</button></form>
    <details class="conversation-memory"><summary>What Milo remembers <span id="memory-count">This chat only</span></summary><p id="memory-detail">Explicit details and a short conversation summary will appear here. New chat clears everything.</p></details>
    <p class="conversation-note">English voice · Local inference · Whisper + Qwen + Kokoro</p>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  const checked = (id: string) => el<HTMLInputElement>(id).checked;
  const recorder = new MicrophoneRecorder();
  const messages: Message[] = [];
  const facts = new Map<string, string>();
  let summary = '', summarizedThrough = 0, memoryVersion = 0;
  let summaryRequest: AbortController | undefined;
  let state: State = 'idle', detail = 'Start talking, or send a little note below.';
  let visible = false, version = 0, ownsPlayback = false, loop = false, receivedReply = false;
  let health: Health | undefined, healthError = '', checking = false, preparing = false, profilePending = false;
  let profile: ChatMode = 'fast';
  let gpuIntent: boolean | undefined, gpuRevision: number | undefined, gpuEpoch = 0, gpuError = '';
  let gpuRequest: AbortController | undefined;
  let replyRoute: ReplyRoute | undefined;
  let request: AbortController | undefined;
  let nextListen: ReturnType<typeof setTimeout> | undefined;
  let micMuted = false, micLive = false, selectedDevice = '', deviceQuery = 0, disposed = false;
  let micAccessBusy = false, micAccessVersion = 0, permissionStream: MediaStream | undefined;
  container.querySelector('.mic-controls')!.insertAdjacentHTML('beforeend', '<div class="mic-selection-help"><p id="mic-selection-status" role="status">Checking microphones…</p><button id="mic-enable-selection" class="text-button" hidden>Allow microphone access</button></div>');
  let voiceArmed = false, monitoring = false, monitorSuppressed = false, inputLevel = 0;
  const busy = () => !['idle', 'error', 'speaking'].includes(state);
  const textReady = () => gpuIntent === undefined && health?.chat.acceleration?.status !== 'switching' && health?.chat.status === 'ready' && (!health.chat.profile || health.chat.profile === profile) && health?.tts.status === 'ready';
  const voiceReady = () => textReady() && health?.stt.status === 'ready';
  const memory = (): ConversationMemory => ({ summary, facts: [...facts.values()] });

  function renderMemory() {
    el('memory-count').textContent = facts.size || summary ? `${facts.size} details${summary ? ' + summary' : ''}` : 'This chat only';
    el('memory-detail').textContent = [...facts.values(), summary && `Earlier conversation: ${summary}`, 'Stored only for this chat. New chat clears everything.'].filter(Boolean).join('\n');
  }
  function render() {
    const remote = usesCodex();
    const modeSelect = el<HTMLSelectElement>('conversation-model');
    modeSelect.options[0].text = remote ? 'Fast · Less thought' : 'Fast · Qwen 1.5B';
    modeSelect.options[1].text = remote ? 'Better answers · More thought' : 'Better answers · Qwen 4B';
    for (const option of el<HTMLSelectElement>('conversation-voice').options) option.text = voiceLabel(option.value).split(' · ')[0];
    const start = el<HTMLButtonElement>('conversation-start');
    start.textContent = state === 'listening' ? 'Send voice message' : ['transcribing', 'thinking', 'voicing'].includes(state) ? `${labels[state]}…` : micMuted ? 'Unmute & talk' : state === 'speaking' ? 'Interrupt & talk' : 'Start conversation';
    start.disabled = micAccessBusy || (state !== 'listening' && (!voiceReady() || ['transcribing', 'thinking', 'voicing'].includes(state)));
    el<HTMLButtonElement>('conversation-end').disabled = ['idle', 'error'].includes(state) && !loop;
    el<HTMLButtonElement>('conversation-send').disabled = !textReady() || busy() || !el<HTMLInputElement>('conversation-input').value.trim();
    el<HTMLSelectElement>('conversation-model').disabled = gpuIntent !== undefined || health?.chat.acceleration?.status === 'switching' || ownsPlayback || recorder.active || Boolean(summaryRequest) || !health || health.chat.status === 'loading' || (health.chat.queueDepth ?? 0) > 0 || !['idle', 'error'].includes(state);
    el('model-hint').textContent = profile === 'fast' ? 'Quick, everyday conversation. 1.1 GB on first use.' : profile === 'quality' ? 'More capable replies. 2.5 GB on first use; slower on CPU.' : health?.chat.acceleration?.enabled ? health.chat.residency === 'dual' ? 'Quick on CPU. Deeper replies on GPU. Both stay ready.' : 'Quick on CPU. Deeper replies load onto the GPU.' : health?.chat.residency === 'single' ? 'Adapts each reply. Models load as needed to save memory.' : 'Quick for simple turns. More thought when it matters.';
    el('model-hint').title = profile === 'hybrid' ? health?.chat.residencyReason || 'Both local models are prepared when memory allows. First use downloads 3.6 GB in total.' : '';
    if (isDeviceOnly) {
      (container.querySelector('.conversation-acceleration') as HTMLElement).hidden = !health?.chat.acceleration?.available && !health?.chat.acceleration?.enabled;
      (container.querySelector('.conversation-note') as HTMLElement).textContent = usesHostedVoice() ? `Voice by Deepgram · listening and replies stay in this browser · ${health?.chat.device === 'gpu' ? 'GPU replies' : 'CPU'}` : `English voice · AI stays in this browser · ${health?.chat.device === 'gpu' ? 'GPU replies' : 'CPU'}`;
      if (profile === 'hybrid') el('model-hint').textContent = 'Adapts each reply. One model is loaded at a time.';
    }
    if (remote) {
      (container.querySelector('.conversation-acceleration') as HTMLElement).hidden = true;
      (container.querySelector('.conversation-note') as HTMLElement).textContent = usesHostedVoice() ? 'Listening on your device · Replies through ChatGPT · Voice by Deepgram' : 'Voice on your device · Replies through your ChatGPT account';
      el('model-hint').textContent = profile === 'hybrid' ? 'Adjusts thinking effort for each reply using your selected ChatGPT model.' : profile === 'fast' ? 'Uses a lighter supported thinking effort.' : 'Uses a deeper supported thinking effort.';
      el('model-hint').title = 'ChatGPT replies use your account allowance. Local GPU acceleration does not apply.';
    }
    el('conversation-route').hidden = profile !== 'hybrid';
    el('conversation-route').dataset.depth = replyRoute?.profile || 'auto';
    el('route-label').textContent = !replyRoute ? 'Chooses for each reply' : replyRoute.profile === 'fast' ? 'Quick reply' : ['thinking', 'voicing'].includes(state) ? 'Thinking deeper' : 'Considered reply';
    el('route-reason').textContent = replyRoute?.reason || 'Simple chat stays quick. Complex questions get more thought.';
    const acceleration = health?.chat.acceleration;
    const gpuEnabled = gpuIntent ?? acceleration?.enabled ?? false;
    const switchingGpu = gpuIntent !== undefined || acceleration?.status === 'switching';
    const gpuResidentReady = Object.values(health?.chat.residentModels ?? {}).some(model => model.status === 'ready' && model.device === 'gpu');
    const readyDeviceLabel = health?.chat.device === 'gpu' ? 'GPU active' : profile === 'hybrid' ? gpuResidentReady ? 'GPU ready · quick replies use CPU' : 'GPU selected for deeper replies' : 'Preparing GPU replies…';
    const toggle = el<HTMLButtonElement>('gpu-toggle');
    toggle.setAttribute('aria-checked', String(gpuEnabled));
    // OFF remains available while a GPU model is loading or answering.
    toggle.disabled = !gpuEnabled && (!acceleration?.available || isDeviceOnly && health?.chat.status === 'unloaded');
    toggle.title = 'Switching stops the current turn and reloads the same models. Your chat and memory stay here.';
    el('gpu-toggle-label').textContent = gpuEnabled ? 'On' : 'Off';
    el('gpu-device').textContent = acceleration?.deviceName || (acceleration?.status === 'unavailable' ? 'Compatible GPU unavailable' : 'Checking compatible hardware…');
    el('gpu-device').title = acceleration?.message || '';
    const gpuDetails = el('gpu-details');
    gpuDetails.textContent = acceleration?.deviceInfo || '';
    gpuDetails.hidden = !acceleration?.deviceInfo;
    el('gpu-status').textContent = gpuError || (switchingGpu ? gpuIntent === undefined ? acceleration?.message || 'Preparing replies on this device…' : gpuEnabled ? 'Switching to GPU…' : 'Returning to CPU…' : !acceleration || acceleration.status === 'detecting' ? 'Checking for a GPU…' : gpuEnabled ? health?.chat.status === 'ready' ? readyDeviceLabel : 'Preparing GPU replies…' : acceleration.status === 'unavailable' || acceleration.status === 'error' ? acceleration.message || 'GPU unavailable. CPU replies are available.' : acceleration.message || 'CPU active · GPU is optional');
    el('conversation-status').textContent = detail;
    container.dataset.state = state;
    container.dataset.micMuted = String(micMuted);
    el('mic-toggle').setAttribute('aria-pressed', String(micMuted));
    el('mic-toggle').setAttribute('aria-label', micMuted ? 'Unmute microphone' : 'Mute microphone');
    el('mic-toggle-label').textContent = micMuted ? 'Unmute mic' : 'Mute mic';
    el('mic-state').textContent = micMuted ? 'Mic muted' : monitoring ? 'Listening for interruption' : state === 'listening' ? micLive ? 'Listening' : 'Waiting for permission' : ['transcribing', 'thinking', 'voicing', 'speaking'].includes(state) ? 'Mic paused' : 'Mic idle';
    el('conversation-engines').textContent = healthError || (!health ? 'Connecting to your local engines…' : [
      ['Whisper', health.stt], [remote ? 'ChatGPT' : (health.chat.profile ?? profile) === 'hybrid' ? 'Hybrid' : (health.chat.profile ?? profile) === 'quality' ? 'Qwen 4B' : 'Qwen 1.5B', health.chat], [usesHostedVoice() ? 'Deepgram voice' : 'Kokoro', health.tts],
    ].map(([name, value]) => { const engine = value as Engine; return `${name} ${engine.status === 'ready' ? '✓' : engine.status === 'unloaded' ? 'not loaded' : engine.status === 'error' ? 'unavailable' : Number.isFinite(engine.progress) ? `${Math.round(engine.progress!)}%` : 'loading'}`; }).join('   ·   '));
    el('conversation-engines').title = 'All inference stays on this computer. Conversation replies can use the GPU; listening and speech use CPU. Models are cached for later use.';
    if (isDeviceOnly) el('conversation-engines').title = usesHostedVoice() ? 'Listening and replies run in this browser; compatible browsers accelerate replies with the GPU. Milo’s voice is made by Deepgram from the text it says.' : 'Listening and voice run on your browser’s CPU. Compatible browsers can accelerate replies with the GPU. The step above prepares them. No server fallback.';
    if (remote) el('conversation-engines').title = 'Voice and listening stay on this device. Messages and conversation context are sent to OpenAI through Milo’s hosted connection.';
    const emptyNote = container.querySelector<HTMLElement>('.conversation-empty > span:last-child');
    if (emptyNote) emptyNote.textContent = remote ? 'ChatGPT receives this conversation’s text.' : 'Your conversation stays in this tab.';
    renderNextStep(remote);
    options.onStateChange();
  }
  let nextAction: (() => void) | undefined;
  let codexLogin: (() => void) | undefined;
  const retry = () => { if (options.device) options.device.start(); else void prepare(); };
  /** Name the one thing standing between the visitor and a conversation, and offer it in place. */
  function renderNextStep(remote: boolean) {
    const device = options.device?.describe();
    const engines: Engine[] = health ? remote ? [health.tts, health.stt] : [health.tts, health.stt, health.chat] : [];
    const names = ['Voice', 'Listening', 'Replies'];
    const failed = engines.find(engine => engine.status === 'error');
    const unloaded = engines.some(engine => engine.status === 'unloaded');
    const loading = engines.some(engine => engine.status === 'loading') || health?.chat.acceleration?.status === 'switching' || gpuIntent !== undefined;
    const progress = engines.map((engine, i) => `${names[i]} ${engine.status === 'ready' ? 'ready' : engine.status === 'loading' ? Number.isFinite(engine.progress) ? `${Math.round(engine.progress!)}%` : 'preparing' : 'waiting'}`).join(' · ');
    let step: { text: string; action?: string; run?: () => void; busy?: boolean } | undefined;
    if (healthError) step = { text: healthError, action: 'Try loading again', run: retry, busy: device?.busy };
    else if (!health) step = undefined;
    else if (device && !device.supported) step = { text: device.capability };
    else if (failed) step = { text: `${failed.message || 'Milo could not load on this device.'} Close other busy tabs, then try again.`, action: 'Try loading again', run: retry, busy: device?.busy };
    else if (remote && health.chat.status !== 'ready') {
      const codex = codexStatus();
      step = !codex?.signedIn
        ? { text: `Replies come from your ChatGPT account. Sign in on OpenAI’s page; Milo connects automatically when you return.${unloaded ? ' Milo’s voice and listening are prepared on this device afterwards.' : ''}`, action: codex?.login ? 'Show the sign-in code' : 'Sign in to ChatGPT ↗', run: () => codexLogin?.() }
        : { text: 'Your ChatGPT account returned no usable models. Choose a different account or switch the reply provider to On this device.' };
    } else if (loading || device?.busy) step = { text: `Milo is getting ready on this device: ${progress}. You can type as soon as replies are ready.` };
    else if (unloaded && device) {
      const text = remote ? 'Prepare Milo’s voice and listening on this device. Your ChatGPT account provides the replies.'
        : device.saved === 'all' ? 'Your models are already saved in this browser. Load them to start talking; nothing downloads again.'
          : device.saved === 'some' ? 'Some files are already saved here. Milo downloads only what is missing, then starts.'
            : usesHostedVoice() ? 'Milo needs its listening and reply models on this device. Your recordings and replies stay in this browser; only the text Milo says goes to Deepgram for its voice.' : 'Milo needs its voice, listening and reply models on this device. Nothing you say leaves this browser.';
      step = { text: `${text} ${device.size}.`, action: device.saved === 'all' ? 'Load saved models ↘' : device.saved === 'some' ? 'Download missing files & prepare ↘' : 'Download & prepare ↘', run: options.device!.start, busy: device.busy };
    }
    nextAction = step?.run;
    el('conversation-next').hidden = !step;
    el('conversation-next-text').textContent = step?.text ?? '';
    const action = el<HTMLButtonElement>('conversation-next-action');
    action.hidden = !step?.action; action.textContent = step?.action ?? ''; action.disabled = !!step?.busy;
  }
  function setState(next: State, text?: string) { state = next; detail = text ?? `${labels[next]}…`; render(); }
  function setLevel(level: number) {
    inputLevel = Math.max(0, Math.min(1, level));
    const value = Math.round(inputLevel * 100);
    el('mic-level').style.width = `${value}%`;
    el('mic-meter').setAttribute('aria-valuenow', String(value));
  }
  function stopMonitor() { recorder.cancel(); monitoring = false; micLive = false; setLevel(0); }
  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) { el('mic-selection-status').textContent = 'Microphone selection needs a supported browser over HTTPS.'; return; }
    const query = ++deviceQuery;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput' && device.deviceId && !['default', 'communications'].includes(device.deviceId));
      if (disposed || query !== deviceQuery) return;
      const select = el<HTMLSelectElement>('mic-device');
      select.replaceChildren(new Option('System default', ''), ...devices.map((device, i) => new Option(device.label || `Microphone ${i + 1}`, device.deviceId)));
      if (selectedDevice && !devices.some(device => device.deviceId === selectedDevice)) {
        selectedDevice = '';
        if (monitoring) { stopMonitor(); monitorSuppressed = true; loop = false; voiceArmed = false; clearTimeout(nextListen); render(); }
        else if (state === 'listening') { end(); setState('idle', 'That microphone disconnected. Choose another input and start again.'); }
      }
      select.value = selectedDevice;
      select.title = devices.some(device => !device.label) ? 'Microphone names appear after you allow microphone access.' : 'Choose the microphone for your next voice message.';
      const needsAccess = !devices.length || devices.some(device => !device.label);
      el('mic-enable-selection').hidden = !needsAccess;
      el('mic-selection-status').textContent = needsAccess ? 'Allow microphone access to show available inputs.' : `${devices.length} microphone${devices.length === 1 ? '' : 's'} available. Choose an input above.`;
    } catch { el('mic-device').title = 'Could not list microphones. You can still try the system default.'; el('mic-selection-status').textContent = 'Could not list microphones. Allow access and try again.'; el('mic-enable-selection').hidden = false; }
  }
  function cancelMicAccess() {
    micAccessVersion++; permissionStream?.getTracks().forEach(track => track.stop()); permissionStream = undefined;
  }
  async function enableMicSelection() {
    if (micAccessBusy || disposed || !visible) return;
    if (recorder.active) { await refreshDevices(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { el('mic-selection-status').textContent = 'Microphone access needs a supported browser over HTTPS.'; return; }
    micAccessBusy = true;
    const token = ++micAccessVersion, button = el<HTMLButtonElement>('mic-enable-selection');
    button.disabled = true; render(); el('mic-selection-status').textContent = 'Allow microphone access in your browser to reveal the inputs…';
    let stream: MediaStream | undefined;
    try {
      // Permission discovery only: no recorder, audio graph, transcription or upload.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (disposed || !visible || token !== micAccessVersion) return;
      permissionStream = stream;
      await refreshDevices();
      if (token === micAccessVersion && !el('mic-enable-selection').hidden) el('mic-selection-status').textContent = 'Access allowed, but this browser exposes only the system input. Use System default or check your connected microphones.';
    } catch (error) {
      if (disposed || !visible || token !== micAccessVersion) return;
      const name = (error as DOMException).name;
      el('mic-selection-status').textContent = name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access is blocked. Allow it in browser site settings, then try again.' : name === 'NotFoundError' ? 'No microphone found. Connect one, then try again.' : 'The microphone could not open. Close other apps using it, then try again.';
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (permissionStream === stream) permissionStream = undefined;
      micAccessBusy = false; if (!disposed) { button.disabled = false; render(); }
    }
  }
  window.addEventListener('pagehide', cancelMicAccess);
  function setMuted(value: boolean) {
    micMuted = value;
    if (value) {
      cancelMicAccess();
      loop = false; clearTimeout(nextListen); monitorSuppressed = true;
      if (monitoring) stopMonitor();
      else if (state === 'listening') end();
      if (state === 'idle' || state === 'error') detail = 'Microphone muted. You can still type to Milo.';
    } else if (state === 'idle') detail = 'Microphone ready. Start a conversation when you’re ready.';
    render();
  }
  function stopWork(preserveSummary = false) {
    version++; clearTimeout(nextListen);
    request?.abort(); request = undefined;
    if (!preserveSummary) { memoryVersion++; summaryRequest?.abort(); summaryRequest = undefined; }
    stopMonitor();
    ownsPlayback = false; loop = false; voiceArmed = false; monitorSuppressed = false; receivedReply = false;
    replyRoute = undefined;
    player.stop();
  }
  function end() { stopWork(); setState('idle', 'Conversation paused. Start again whenever you’re ready.'); }
  function fail(error: unknown, token: number) {
    if (token !== version || !visible) return;
    stopWork();
    setState('error', error instanceof Error ? error.message : 'Something went wrong. Please try again.');
  }
  function scrollLog() { el('conversation-log').scrollTop = el('conversation-log').scrollHeight; }
  function append(message: Message) {
    messages.push(message); el('conversation-empty')?.remove();
    const bubble = document.createElement('div'); bubble.className = `conversation-message ${message.role}`;
    const name = document.createElement('span'); name.textContent = message.role === 'user' ? 'YOU' : 'MILO';
    const text = document.createElement('p'); text.textContent = message.content;
    bubble.append(name, text); el('conversation-log').append(bubble); scrollLog();
    return text;
  }
  async function post(path: string, body: Blob | object, signal: AbortSignal) {
    const audio = body instanceof Blob;
    const response = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': audio ? 'audio/wav' : 'application/json' }, body: audio ? body : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Milo could not finish that turn. Please try again.');
    return result;
  }
  async function compactMemory() {
    if (summaryRequest || messages.length - summarizedThrough <= 10) return;
    // Compact complete older turns, keeping six recent messages verbatim.
    let endIndex = Math.min(messages.length - 6, summarizedThrough + 12);
    while (endIndex > summarizedThrough && messages[endIndex - 1].role !== 'assistant') endIndex--;
    if (endIndex <= summarizedThrough) return;
    const older = messages.slice(summarizedThrough, endIndex);
    const previousMemory = memory();
    // Save labelled excerpts immediately. If CPU summarization is interrupted
    // by a new turn, older context still has a bounded, non-inferred checkpoint.
    const excerpts = older.map(message => `${message.role === 'user' ? 'User' : 'Milo'}: ${message.content.replace(/\s+/g, ' ').slice(0, 170)}`).join('\n');
    summary = [summary.slice(0, 380), excerpts.slice(-800)].filter(Boolean).join('\n');
    summarizedThrough = endIndex; renderMemory();
    const epoch = memoryVersion;
    const controller = new AbortController(); summaryRequest = controller; render();
    try {
      const result = await post('/api/chat/summary', { messages: older, memory: previousMemory, profile }, controller.signal);
      if (epoch !== memoryVersion || controller.signal.aborted) return;
      summary = String(result.summary || '').slice(0, 1200); summarizedThrough = endIndex; renderMemory();
    } catch { /* Keep the last summary and explicit facts if background compaction fails. */ }
    finally { if (summaryRequest === controller) { summaryRequest = undefined; if (visible) render(); } }
  }
  async function reply(text: string, token: number) {
    if (token !== version) return;
    memoryVersion++; summaryRequest?.abort(); summaryRequest = undefined;
    if (messages.at(-1)?.role === 'user') messages.pop();
    append({ role: 'user', content: text }); rememberExplicitFacts(text, facts); renderMemory();
    receivedReply = false; replyRoute = undefined;
    setState('thinking', 'Milo is thinking about what you said…');
    const controller = new AbortController(); request = controller;
    const context = messages.slice(-11);
    const assistant: Message = { role: 'assistant', content: '' };
    let paragraph: HTMLElement | undefined;
    async function* sentences() {
      let spokenBuffer = '', spokenChunks = 0;
      const response = await apiFetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: context, memory: memory(), profile }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(isDeviceOnly ? 20 * 60_000 : 180_000)]),
      });
      for await (const event of readReplyStream(response)) {
        if (token !== version || !visible) return;
        if (event.type === 'routing' && profile === 'hybrid' && (event.profile === 'fast' || event.profile === 'quality')) {
          replyRoute = { profile: event.profile, reason: typeof event.reason === 'string' ? event.reason.slice(0, 240) : event.profile === 'quality' ? 'This question benefits from more reasoning.' : 'A straightforward conversational turn.' };
          setState('thinking', event.profile === 'quality' ? 'Milo is taking a little more time to think this through…' : 'Milo is putting together a quick reply…');
        } else if (event.type === 'delta' && event.text) {
          if (!paragraph) paragraph = append(assistant);
          assistant.content += event.text; paragraph.textContent = assistant.content; scrollLog();
          receivedReply = true; options.onSpeech(assistant.content);
          spokenBuffer += event.text;
          // Text streams as words. Send only complete phrases to the voice engine.
          let boundary: RegExpExecArray | null;
          const punctuation = /[.!?]["”’)]*(?:\s+|$)/g;
          while ((boundary = punctuation.exec(spokenBuffer))) {
            const end = boundary.index + boundary[0].length;
            const sentence = spokenBuffer.slice(0, end).trim();
            if (/\b(?:Mr|Mrs|Ms|Dr|Prof|e\.g|i\.e)\.$/i.test(sentence)) continue;
            spokenBuffer = spokenBuffer.slice(end); punctuation.lastIndex = 0;
            if (sentence) { spokenChunks++; yield sentence; }
          }
          // Audio starts sooner when an opening clause of at least six words is
          // voiced while the rest of the first sentence is still being generated.
          // The clause must be followed by whitespace so numbers like 1,000 stay whole.
          if (!spokenChunks) {
            const clause = /^((?:\S+\s+){5,}\S+[,;:])\s+/.exec(spokenBuffer);
            if (clause) { spokenBuffer = spokenBuffer.slice(clause[0].length); spokenChunks++; yield clause[1]; }
          }
        } else if (event.type === 'done') {
          if (!assistant.content.trim()) throw new Error('Milo did not produce a reply. Please try again.');
          if (event.text) { assistant.content = event.text; paragraph!.textContent = event.text; options.onSpeech(event.text); }
          if (spokenBuffer.trim()) yield spokenBuffer.trim();
          spokenBuffer = '';
        }
      }
    }
    try {
      ownsPlayback = true;
      const voice = options.getVoice();
      await player.speakStream(sentences(), voice.voice, voice.speed);
      if (token === version && visible && player.state !== 'error') void compactMemory();
    } catch (error) { fail(error, token); }
    finally { if (request === controller) request = undefined; }
  }
  function captureComplete(wav: Blob, token: number) {
    if (token !== version || !visible) return;
    monitoring = false; micLive = false; setLevel(0);
    setState('transcribing', 'Turning your voice into words…');
    request = new AbortController();
    void post('/api/transcribe', wav, request.signal).then(result => {
      if (token === version && visible) return reply(result.text, token);
    }).catch(error => fail(error, token));
  }
  async function listen(continueLoop = true, preserveSummary = false) {
    if (!visible || !voiceReady() || micMuted || micAccessBusy) return;
    stopWork(preserveSummary); loop = continueLoop; voiceArmed = true;
    const token = version;
    setState('listening', 'Go ahead. A short pause sends your message.');
    void player.unlock().catch(error => fail(error, token));
    await recorder.start({ deviceId: selectedDevice,
      onStarted: () => { if (token === version && visible) { micLive = true; render(); void refreshDevices(); } },
      onLevel: level => { if (token === version) setLevel(level); },
      onError: message => fail(new Error(message), token),
      onComplete: wav => captureComplete(wav, token),
    });
  }
  async function startMonitor() {
    if (!visible || !voiceArmed || micMuted || monitorSuppressed || recorder.active || monitoring || !checked('conversation-interrupt')) return;
    let token = version;
    monitoring = true; render();
    await recorder.start({ deviceId: selectedDevice, waitForSpeech: true, startThreshold: 0.045, startSpeechSeconds: 0.18, maxInitialSilenceMs: 120_000,
      onStarted: () => { if (token === version && visible && monitoring) { micLive = true; render(); } },
      onLevel: level => { if (token === version) setLevel(level); },
      onSpeechStart: () => {
        if (token !== version || !visible || !monitoring) return;
        // Keep this capture and its pre-roll; invalidate only the outgoing reply.
        token = ++version; clearTimeout(nextListen);
        request?.abort(); request = undefined; memoryVersion++; summaryRequest?.abort(); summaryRequest = undefined;
        ownsPlayback = false; receivedReply = false; monitoring = false; loop = true;
        player.stop(true);
        setState('listening', 'Go ahead — I’m listening.');
      },
      onError: message => {
        if (token !== version || !visible) return;
        if (!monitoring) { fail(new Error(message), token); return; }
        stopMonitor(); monitorSuppressed = true; loop = false;
        render(); el('mic-state').textContent = message;
      },
      onComplete: wav => captureComplete(wav, token),
    });
  }
  function onPlaybackChange() {
    if (!ownsPlayback || !visible) return;
    if (player.state === 'generating') setState(receivedReply ? 'voicing' : 'thinking', receivedReply ? 'The next part of Milo’s reply is on its way…' : replyRoute?.profile === 'quality' ? 'Milo is taking a little more time to think this through…' : 'Milo is thinking about what you said…');
    else if (player.state === 'playing') {
      setState('speaking', voiceArmed && checked('conversation-interrupt') && !micMuted ? 'Milo is talking. Speak whenever you want to jump in.' : 'Milo is talking. You can interrupt to take a turn.');
      void startMonitor();
    } else if (player.state === 'error') fail(new Error(player.error), version);
    else if (player.state === 'idle' && receivedReply && !player.streaming) {
      ownsPlayback = false;
      if (monitoring) stopMonitor();
      setState('idle', 'Your turn. What’s on your mind?');
      if (loop && !micMuted && checked('conversation-loop')) {
        const token = version;
        nextListen = setTimeout(() => { if (token === version && visible && loop && !micMuted && checked('conversation-loop')) void listen(true, true); }, 350);
      } else { loop = false; voiceArmed = false; render(); }
    }
  }
  function acceptHealth(next: Health, fromPoll = false) {
    const revision = next.chat.acceleration?.revision;
    if (typeof revision === 'number') {
      if (fromPoll && gpuRevision !== undefined && revision !== gpuRevision && gpuIntent === undefined) {
        stopWork();
        state = 'idle';
        detail = 'Acceleration changed. Your chat is here; this turn has stopped.';
      }
      gpuRevision = revision;
    }
    health = next;
    if (fromPoll && next.chat.acceleration?.status === 'ready') gpuError = '';
  }
  async function setGpu(enabled: boolean) {
    if (enabled && !health?.chat.acceleration?.available) return;
    const epoch = ++gpuEpoch;
    gpuRequest?.abort();
    stopWork();
    gpuIntent = enabled; gpuError = '';
    setState('idle', enabled ? 'Switching to GPU. Your conversation and memory stay here.' : 'Returning to CPU. Your conversation and memory stay here.');
    const controller = new AbortController();
    gpuRequest = controller;
    try {
      const response = await apiFetch('/api/conversation/acceleration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(isDeviceOnly ? 20 * 60_000 : 10000)]),
      });
      const result = await response.json();
      if (epoch !== gpuEpoch || disposed) return;
      if (!response.ok) throw new Error(result.message || 'Could not change acceleration. CPU mode remains available.');
      acceptHealth(result); healthError = '';
    } catch (error) {
      if (epoch !== gpuEpoch || disposed) return;
      gpuError = error instanceof Error ? error.message : 'Could not change acceleration. Try again.';
    } finally {
      if (epoch === gpuEpoch) {
        gpuIntent = undefined; gpuRequest = undefined;
        if (visible) { render(); void checkHealth(); }
      }
    }
  }
  async function checkHealth() {
    if (checking || !visible) return;
    checking = true;
    const epoch = gpuEpoch;
    try {
      const response = await apiFetch('/api/conversation/health', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('offline');
      const next: Health = await response.json();
      if (epoch !== gpuEpoch || !visible) return;
      const wasReady = voiceReady(); acceptHealth(next, true); healthError = '';
      if (health?.chat.profile === profile) profilePending = false;
      if (!profilePending && health?.chat.profile && ['fast', 'quality', 'hybrid'].includes(health.chat.profile) && !ownsPlayback && !recorder.active && ['idle', 'error'].includes(state)) {
        // The local model is shared across tabs. Adopt an intentional change
        // made elsewhere instead of each tab repeatedly switching it back.
        profile = health.chat.profile as ChatMode;
        el<HTMLSelectElement>('conversation-model').value = profile;
      }
      if (!wasReady && voiceReady() && state === 'idle') detail = 'Ready when you are. Start talking, or type a message.';
      // A cancelled worker may still be draining when a profile was selected.
      // Retry that selection once it is idle, instead of leaving the UI stranded.
      if (profilePending && health?.chat.profile && health.chat.profile !== profile && health.chat.status !== 'loading' && !(health.chat.queueDepth ?? 0) && ['idle', 'error'].includes(state)) void prepare();
    } catch { if (epoch === gpuEpoch) { healthError = isDeviceOnly ? 'The browser engines could not start. Try loading again below.' : 'Local conversation is offline. Start the app, then try loading again.'; health = undefined; } }
    finally { checking = false; if (visible) render(); }
  }
  async function prepare() {
    if (preparing || gpuIntent !== undefined || health?.chat.acceleration?.status === 'switching') return;
    preparing = true; profilePending = true;
    const token = version;
    try {
      const response = await apiFetch('/api/conversation/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Cannot prepare the selected model.');
      if (!visible || token !== version) return;
      acceptHealth(result); healthError = '';
      if (!health?.chat.profile || health.chat.profile === profile) profilePending = false;
      if (!voiceReady() && ['idle', 'error'].includes(state)) setState('idle', isDeviceOnly ? 'Milo needs a little setup first. Follow the step above.' : profile === 'hybrid' ? 'Preparing Hybrid. Milo will choose the right model for each reply.' : profile === 'quality' ? 'Preparing the 4B model. First use downloads 2.5 GB; later runs use the cache.' : 'Preparing your local engines. First use downloads the models; later runs use the cache.');
      render();
    } catch (error) { if (visible && token === version) { healthError = error instanceof Error ? error.message : 'Cannot prepare the local engines.'; render(); } }
    finally { preparing = false; }
  }
  el('conversation-start').addEventListener('click', () => { if (state === 'listening') recorder.finish(); else { if (micMuted) setMuted(false); void listen(); } });
  el('mic-toggle').addEventListener('click', () => setMuted(!micMuted));
  el('mic-refresh').addEventListener('click', () => void refreshDevices());
  el('mic-enable-selection').addEventListener('click', () => void enableMicSelection());
  el('gpu-toggle').addEventListener('click', () => void setGpu(!(gpuIntent ?? health?.chat.acceleration?.enabled ?? false)));
  el('mic-device').addEventListener('change', () => {
    selectedDevice = el<HTMLSelectElement>('mic-device').value;
    if (monitoring) { stopMonitor(); monitorSuppressed = true; loop = false; voiceArmed = false; clearTimeout(nextListen); render(); }
    else if (state === 'listening') { end(); setState('idle', 'Microphone changed. Start again to use the new input.'); }
  });
  el('conversation-interrupt').addEventListener('change', () => {
    if (!checked('conversation-interrupt') && monitoring) { stopMonitor(); render(); }
    else if (player.state === 'playing' && ownsPlayback) { monitorSuppressed = false; void startMonitor(); }
  });
  el('conversation-model').addEventListener('change', () => {
    stopWork(); profile = el<HTMLSelectElement>('conversation-model').value as ChatMode;
    health = undefined; setState('idle', 'Preparing the selected mind…'); void prepare();
  });
  const onDeviceChange = () => { if (visible) void refreshDevices(); };
  navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);
  el('conversation-end').addEventListener('click', end);
  el('conversation-next-action').addEventListener('click', () => { nextAction?.(); render(); });
  el('new-conversation').addEventListener('click', () => {
    end(); messages.length = 0; facts.clear(); summary = ''; summarizedThrough = 0;
    el('conversation-log').replaceChildren(); renderMemory(); setState('idle', 'A fresh conversation. Say hello or type a message.');
  });
  el('conversation-input').addEventListener('input', render);
  el('conversation-loop').addEventListener('change', () => { if (!checked('conversation-loop')) { clearTimeout(nextListen); loop = false; render(); } });
  el('conversation-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = el<HTMLInputElement>('conversation-input'); const text = input.value.trim();
    if (!text || !textReady() || busy()) return;
    stopWork(); input.value = ''; const token = version;
    void player.unlock().then(() => { if (token === version) return reply(text, token); }).catch(error => fail(error, token));
  });
  el<HTMLSelectElement>('conversation-voice').value = options.getVoice().voice;
  el('conversation-voice').addEventListener('change', () => options.setVoice(el<HTMLSelectElement>('conversation-voice').value));
  const healthTimer = setInterval(() => void checkHealth(), 2000);
  const providerContainer = document.createElement('div'); providerContainer.className = 'reply-provider-panel';
  container.querySelector('.conversation-model')!.before(providerContainer);
  const codexPanel = createCodexPanel(providerContainer, () => { stopWork(); gpuRequest?.abort(); gpuIntent = undefined; gpuEpoch++; health = undefined; setState('idle', 'Reply provider changed. Prepare the selected voice and connection to continue.'); });
  codexLogin = () => codexPanel.login();
  const onProviderChange = () => { gpuEpoch++; void checkHealth().then(() => { if (visible) void prepare(); }); };
  window.addEventListener('milo-provider-change', onProviderChange);
  const onDeviceHealth = () => { if (isDeviceOnly) void checkHealth(); };
  if (isDeviceOnly) window.addEventListener('milo-device-change', onDeviceHealth);
  window.addEventListener('milo-voice-change', render);
  return {
    get label() { return state === 'thinking' && replyRoute?.profile === 'quality' && profile === 'hybrid' ? 'Thinking deeper' : labels[state]; }, get state() { return state; },
    get presenceState(): State { return state === 'listening' && !micLive ? 'idle' : state; },
    get inputLevel() { return inputLevel; },
    onPlaybackChange,
    setVisible(value: boolean) {
      visible = value; container.hidden = !value;
      if (value) { el<HTMLSelectElement>('conversation-voice').value = options.getVoice().voice; void checkHealth().then(() => { if (visible) void prepare(); }); void refreshDevices(); render(); }
      else { cancelMicAccess(); end(); }
    },
    cancel: end,
    dispose() { disposed = true; visible = false; cancelMicAccess(); window.removeEventListener('pagehide', cancelMicAccess); stopWork(); gpuRequest?.abort(); codexPanel.dispose(); window.removeEventListener('milo-provider-change', onProviderChange); clearInterval(healthTimer); window.removeEventListener('milo-device-change', onDeviceHealth); window.removeEventListener('milo-voice-change', render); navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange); },
  };
}

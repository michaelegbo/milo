import { apiFetch } from './transport';
import { isDeviceOnly, MILO_REPOSITORY } from './deployment';
import { createDevicePanel } from './device/panel';
import './style.css';
import { createAvatar, type AvatarPresence } from './avatar';
import { SpeechPlayer } from './speech';
import { createConversation } from './conversation';
import { inferUtteranceMood } from './utterance-mood';

const paths: Record<string, string> = {
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
  play: '<path d="m9 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  wave: '<path d="M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4"/>',
  hand: '<path d="M9 11V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9a7 7 0 0 1-12 5l-5-5a2 2 0 0 1 3-3l2 2v-3Z"/>',
  leaf: '<path d="M20 3C5 2 2 9 6 15c6 7 15 0 14-12ZM4 21 15 10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.spark}</svg>`;
const presets = [
  { title: 'A little introduction', category: 'SAY HELLO', icon: 'hand', text: "Hey there! I'm Milo, your little digital companion. Pick a sentence, and let's bring it to life." },
  { title: 'You’ve got this', category: 'A LITTLE ENCOURAGEMENT', icon: 'spark', text: "Big things start with small steps. You don't have to have it all figured out. Just keep creating. You've got this!" },
  { title: 'A moment to slow down', category: 'TAKE A BREATHER', icon: 'leaf', text: "Let's take a little break. Relax your shoulders, take a deep breath, and give yourself a moment. There's no rush." },
];
const defaults = { selected: 0, mode: 'presets', custom: '', voice: 'am_michael', speed: 1, gestures: !matchMedia('(prefers-reduced-motion: reduce)').matches, motion: !matchMedia('(prefers-reduced-motion: reduce)').matches };
let saved: Partial<typeof defaults> = {};
try { saved = JSON.parse(localStorage.getItem('milo-studio-v1') || '{}') ?? {}; } catch { /* Defaults also work when storage is disabled. */ }
const settings = {
  selected: Number.isInteger(saved.selected) && Number(saved.selected) >= 0 && Number(saved.selected) < presets.length ? Number(saved.selected) : 0,
  mode: saved.mode === 'custom' ? 'custom' : 'presets',
  custom: typeof saved.custom === 'string' ? saved.custom.slice(0, 600) : '',
  voice: ['am_michael', 'af_heart', 'bf_emma'].includes(saved.voice || '') ? saved.voice! : defaults.voice,
  speed: Number(saved.speed) >= 0.7 && Number(saved.speed) <= 1.3 ? Number(saved.speed) : 1,
  motion: typeof saved.motion === 'boolean' ? saved.motion : defaults.motion,
  gestures: typeof saved.gestures === 'boolean' ? saved.gestures : defaults.gestures,
};
function save() { try { localStorage.setItem('milo-studio-v1', JSON.stringify(settings)); } catch { /* Session remains usable. */ } }
const currentText = () => settings.mode === 'presets' ? presets[settings.selected].text : settings.custom.trim();

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="header">
    <a class="brand" href="/" aria-label="Milo home"><span class="brand-symbol"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17V7l9 8 9-8v10" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>milo<span class="brand-period">.</span></span></a>
    <nav aria-label="Main navigation"><span class="nav-active" aria-current="page">Avatar studio</span><button id="about-button">Behind the voice ${icon('arrow')}</button></nav>
    <div class="local-label"><span class="status-dot"></span> ${isDeviceOnly ? 'Voice on your device' : 'Made to run locally'}</div>
  </header>
  <main>
    <section class="intro" aria-labelledby="page-title"><div><div class="eyebrow">A LITTLE EXPERIMENT IN EXPRESSION</div><h1 id="page-title">Give a little character a voice<span>.</span></h1><p>Choose the words. Milo will do the talking.</p>${isDeviceOnly ? `<div class="device-source-links"><a href="${MILO_REPOSITORY}" target="_blank" rel="noreferrer">View source ${icon('arrow')}</a><a href="${MILO_REPOSITORY}/archive/refs/heads/main.zip">Download Milo ${icon('download')}</a><span>Free for personal, noncommercial use</span></div>` : ''}</div><span class="edition">STUDIO / 001</span></section>
    <div class="studio-modes" role="tablist" aria-label="Studio mode"><button id="studio-mode" role="tab" aria-selected="true" aria-controls="script-section">Sentence studio</button><button id="conversation-mode" role="tab" aria-selected="false" aria-controls="conversation-panel" tabindex="-1">Conversation <span>NEW</span></button></div>
    <section id="device-setup" class="device-setup" aria-label="Start Milo on your device" ${isDeviceOnly ? '' : 'hidden'}></section>
    <div class="workspace">
      <section class="character-panel" aria-label="Milo 3D avatar preview">
        <div class="preview-header"><span class="eyebrow">MEET YOUR CHARACTER</span><span class="preview-badge" id="avatar-state"><span class="status-dot"></span> Ready when you are</span></div>
        <div id="avatar-canvas" role="img" aria-label="Milo, a cream and orange 3D robot. Drag to rotate the character."></div>
        <div class="character-signature"><h2>Milo<span>✳</span></h2><p>A curious little companion.</p></div>
        <div class="preview-tools"><span class="orbit-hint">${icon('reset')} <span>Drag to look around</span></span><div><button class="icon-button" id="reset-view" aria-label="Reset avatar view" title="Reset view">${icon('reset')}</button><label class="motion-toggle"><input type="checkbox" id="motion" aria-label="Idle motion" /><span class="switch"></span>Idle</label><label class="gesture-toggle"><input type="checkbox" id="gestures" aria-label="Talking gestures" /><span class="switch"></span>Gestures</label></div></div>
      </section>
      <section id="script-section" class="script-panel" aria-labelledby="script-heading">
        <div class="panel-heading"><div><span class="eyebrow">THE SCRIPT</span><h2 id="script-heading">What’s on your mind?</h2></div>${icon('wave', 'heading-wave')}</div>
        <div class="tabs" role="tablist" aria-label="Sentence source"><button id="preset-tab" role="tab" aria-controls="preset-panel">Pick a sentence</button><button id="custom-tab" role="tab" aria-controls="custom-panel">Write your own</button></div>
        <div id="preset-panel" role="tabpanel" aria-labelledby="preset-tab"><div class="presets" role="group" aria-label="Predefined sentences">${presets.map((p, i) => `<button class="preset" data-preset="${i}" aria-pressed="false"><span class="preset-icon">${icon(p.icon)}</span><span class="preset-text"><span class="preset-category">${p.category}</span><span class="preset-title">${p.title}</span></span><span class="radio-mark">${icon('check')}</span></button>`).join('')}</div><div class="sentence-preview"><span class="quote-mark">“</span><p id="sentence-text"></p></div></div>
        <div id="custom-panel" role="tabpanel" aria-labelledby="custom-tab" hidden><label class="text-label" for="custom-text">Your words, Milo’s voice.</label><textarea id="custom-text" maxlength="600" placeholder="Hey Milo, let's say something wonderful…" aria-describedby="text-help"></textarea><div class="text-help" id="text-help"><span>Keep it short. Make it yours.</span><span id="char-count">0 / 600</span></div></div>
        <div class="voice-settings"><label for="voice"><span class="field-label">VOICE</span><select id="voice"><option value="am_michael">Michael · American</option><option value="af_heart">Heart · American</option><option value="bf_emma">Emma · British</option></select></label><label for="speed"><span class="field-label">PACE <output id="speed-value" for="speed">1.0×</output></span><input type="range" id="speed" min="0.7" max="1.3" value="1" step="0.1" aria-label="Speech pace" /></label></div>
        <div class="speech-actions"><button id="speak" class="primary-button">${icon('play')}<span>Let Milo speak</span></button><button id="stop" class="stop-button" aria-label="Stop speech" title="Stop speech" disabled>${icon('stop')}</button></div>
        <p class="speech-status" id="speech-status" role="status" aria-live="polite">Connecting to the local voice…</p>
        <button class="retry-button" id="retry" hidden>Reconnect to the voice ${icon('reset')}</button>
      </section>
      <section id="conversation-panel" class="conversation-panel" aria-labelledby="conversation-heading" hidden></section>
    </div>
    <section class="audio-strip" aria-label="Generated speech audio"><div class="track-info"><span class="track-icon">${icon('wave')}</span><div><span id="track-title">A voice waiting to happen</span><span class="track-caption" id="track-caption">Your next little moment starts above.</span></div></div><div id="waveform" class="waveform" aria-hidden="true">${Array.from({ length: 64 }, () => '<i></i>').join('')}</div><span class="track-time" id="track-time">0:00 <span>/ 0:00</span></span><button class="icon-button download" id="download" aria-label="Download generated speech as WAV" title="Download WAV" disabled>${icon('download')}</button></section>
    <footer class="footer"><span><span class="tiny-spark">✳</span> A little more human, one sentence at a time.</span><button id="engine-info"><span id="engine-dot" class="status-dot loading"></span><span id="engine-label">Kokoro voice · Connecting</span>${icon('info')}</button></footer>
  </main>
  <dialog id="about-dialog"><div class="dialog-heading"><span class="eyebrow">BEHIND THE VOICE</span><button id="close-about" class="icon-button" aria-label="Close information">${icon('close')}</button></div><h2>Small character.<br>A voice all its own.</h2><p>Milo is made with Three.js. It leans in to listen, glances aside while thinking, and uses a small vocabulary of LED expressions. Articulated hands, body turns, and nods follow the rhythm of speech.</p><p>The voice comes from <strong>Kokoro</strong>, an open-source text-to-speech model running on your computer’s CPU. No GPU or paid voice service is needed.</p><div class="about-note">The first launch downloads the voice model. Conversation adds local listening and reply models; Hybrid can choose a stronger reply model. Everything runs locally. Optional GPU acceleration speeds up replies on compatible hardware; listening and speech stay on CPU. Conversation history stays in this tab and clears on reload.</div><p class="about-limit">Mouth shape follows audio loudness and frequency bands. It is an approximation, not phoneme-accurate lip sync. Simple wording cues give Milo a warm, curious, encouraging, or thoughtful delivery; they do not infer your emotions. Conversation adds Whisper for English speech recognition and Qwen for local replies. Microphone controls let you speak, pause listening, and interrupt Milo.</p><a href="https://github.com/hexgrad/kokoro" target="_blank" rel="noreferrer">Explore Kokoro ${icon('arrow')}</a></dialog>
`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const player = new SpeechPlayer();
let conversation: ReturnType<typeof createConversation> | undefined;
let conversationMode = false;
let deliveryMood: AvatarPresence['expression'] = 'neutral';
const avatarPresence: AvatarPresence = { state: 'idle', inputLevel: 0, expression: 'neutral' };
function readAvatarPresence(): AvatarPresence {
  const state = conversationMode && conversation ? conversation.presenceState
    : player.state === 'playing' ? 'speaking' : player.state === 'generating' ? 'voicing' : player.state === 'error' ? 'error' : 'idle';
  avatarPresence.state = state;
  avatarPresence.inputLevel = conversationMode && conversation ? conversation.inputLevel : 0;
  avatarPresence.expression = state === 'listening' ? 'curious'
    : state === 'thinking' || state === 'transcribing' ? 'thoughtful'
      : state === 'speaking' || state === 'voicing' ? deliveryMood
        : state === 'idle' && player.duration > 0 && player.currentTime === player.duration ? 'warm' : 'neutral';
  return avatarPresence;
}
let avatar: ReturnType<typeof createAvatar> | undefined;
try { avatar = createAvatar(el('avatar-canvas'), () => player.getAudio(), readAvatarPresence); } catch (error) {
  el('avatar-canvas').classList.add('canvas-error');
  el('avatar-canvas').textContent = 'The 3D preview needs WebGL. Enable hardware acceleration in your browser and reload. You can still use the voice controls.';
  console.error(error);
}
let health: 'connecting' | 'unloaded' | 'loading' | 'ready' | 'error' = isDeviceOnly ? 'unloaded' : 'connecting';
let healthMessage = '';
let activeText = '';
let activeTitle = '';
let waveformKey = player.waveform;
const waveformBars = Array.from(el('waveform').children) as HTMLElement[];
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const devicePanel = isDeviceOnly ? createDevicePanel(el('device-setup'), () => { conversation?.cancel(); player.stop(); }) : undefined;
if (isDeviceOnly) {
  document.body.dataset.deployment = 'device';
  const note = document.querySelector<HTMLElement>('.about-note')!;
  note.textContent = 'Milo starts with on-device replies. Models download only after you choose Download & start. Voice and listening run on your CPU; compatible browsers can accelerate local replies with the GPU. Optional ChatGPT mode sends messages and conversation context to OpenAI through your personal desktop companion, using your account allowance. Recordings stay on your device. Models can be cached or deleted in setup. Chat history is held in this tab and clears on reload. Large local models may not fit on phones or tablets. Providers never switch automatically.';
  el('retry').textContent = 'Open model setup';
}

function renderSettings() {
  const custom = settings.mode === 'custom';
  el('preset-panel').hidden = custom;
  el('custom-panel').hidden = !custom;
  for (const [id, selected] of [['preset-tab', !custom], ['custom-tab', custom]] as const) {
    el(id).setAttribute('aria-selected', String(selected)); el(id).tabIndex = selected ? 0 : -1;
  }
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.preset) === settings.selected)));
  el('sentence-text').textContent = presets[settings.selected].text;
  el<HTMLTextAreaElement>('custom-text').value = settings.custom;
  el('char-count').textContent = `${settings.custom.length} / 600`;
  el<HTMLSelectElement>('voice').value = settings.voice;
  el<HTMLInputElement>('speed').value = String(settings.speed);
  el('speed-value').textContent = `${settings.speed.toFixed(1)}×`;
  el<HTMLInputElement>('motion').checked = settings.motion;
  avatar?.setMotion(settings.motion);
  el<HTMLInputElement>('gestures').checked = settings.gestures;
  avatar?.setGestures(settings.gestures);
  renderPlayback();
}

function renderPlayback() {
  const { state } = player;
  const busy = state === 'generating';
  const speaking = state === 'playing';
  const paused = state === 'paused';
  const speak = el<HTMLButtonElement>('speak');
  speak.innerHTML = `${icon(speaking ? 'pause' : busy ? 'wave' : 'play')}<span>${speaking ? 'Pause Milo' : paused ? 'Keep talking' : busy ? 'Finding Milo’s voice…' : 'Let Milo speak'}</span>`;
  speak.disabled = busy || (!speaking && !paused && (health !== 'ready' || !currentText()));
  speak.classList.toggle('generating', busy);
  el<HTMLButtonElement>('stop').disabled = !(busy || speaking || paused);
  el<HTMLButtonElement>('download').disabled = !player.hasAudio;
  const stateLabel = conversationMode && conversation ? conversation.label : speaking ? 'Milo is speaking' : paused ? 'Taking a pause' : busy ? 'A moment, please…' : 'Ready when you are';
  el('avatar-state').innerHTML = `<span class="status-dot ${speaking ? 'talking' : ''}"></span>${stateLabel}`;
  el('avatar-state').classList.toggle('is-speaking', speaking);
  document.querySelector('.audio-strip')?.classList.toggle('is-playing', speaking);
  let status = health === 'ready' ? 'All set. Press play and meet your voice.' : health === 'loading' ? 'Preparing the voice. The first download can take a few minutes.' : health === 'error' ? healthMessage : 'Connecting to the local voice…';
  if (isDeviceOnly && health === 'unloaded') status = 'Choose Download & start voice above. Your words stay on this device.';
  if (busy) status = 'Making your sentence on the CPU. The first one can take a little longer.';
  if (speaking) status = 'Milo is speaking. The mouth moves with the sound.';
  if (paused) status = 'Paused. Continue whenever you’re ready.';
  if (state === 'error') status = player.error;
  if (state === 'idle' && player.hasAudio && player.currentTime === player.duration) status = 'That’s a wrap. Try another sentence or save the audio.';
  el('speech-status').textContent = status;
  el('speech-status').classList.toggle('error', state === 'error' || health === 'error');
  el('retry').hidden = health !== 'error';
  el('track-title').textContent = busy ? 'A little voice in the making…' : player.hasAudio ? activeTitle : 'A voice waiting to happen';
  el('track-caption').textContent = player.hasAudio ? activeText : 'Your next little moment starts above.';
  el('engine-label').textContent = `Kokoro voice · ${health === 'ready' ? isDeviceOnly ? 'Browser CPU ready' : 'CPU ready' : health === 'unloaded' ? 'Not loaded' : health === 'loading' ? 'Preparing' : health === 'error' ? 'Offline' : 'Connecting'}`;
  el('engine-dot').className = `status-dot ${health === 'ready' ? '' : health === 'error' ? 'offline' : 'loading'}`;
}
player.onChange = () => { renderPlayback(); conversation?.onPlaybackChange(); };
conversation = createConversation({
  container: el('conversation-panel'), player,
  getVoice: () => ({ voice: settings.voice, speed: settings.speed }),
  setVoice: voice => { settings.voice = voice; save(); el<HTMLSelectElement>('voice').value = voice; },
  onSpeech: text => { activeText = text; deliveryMood = inferUtteranceMood(text); activeTitle = 'A conversation with Milo'; renderPlayback(); },
  onStateChange: renderPlayback,
});
function setStudioMode(value: boolean) {
  devicePanel?.setConversation(value);
  if (value === conversationMode) return;
  conversationMode = value;
  deliveryMood = 'neutral';
  conversation!.setVisible(value);
  player.stop(true);
  el('script-section').hidden = value;
  for (const [id, selected] of [['studio-mode', !value], ['conversation-mode', value]] as const) {
    el(id).setAttribute('aria-selected', String(selected)); el(id).tabIndex = selected ? 0 : -1;
  }
  document.querySelector('.intro p')!.textContent = value ? 'A little listening. A little talking. A conversation with Milo.' : 'Choose the words. Milo will do the talking.';
  renderPlayback();
}
for (const id of ['studio-mode', 'conversation-mode']) {
  el(id).addEventListener('click', () => setStudioMode(id === 'conversation-mode'));
  el(id).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 'studio-mode' : event.key === 'End' ? 'conversation-mode' : id === 'studio-mode' ? 'conversation-mode' : 'studio-mode';
      el(next).click(); el(next).focus();
    }
  });
}

function changeText() { player.stop(true); save(); renderSettings(); }
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => { settings.selected = Number(button.dataset.preset); changeText(); }));
for (const [id, mode] of [['preset-tab', 'presets'], ['custom-tab', 'custom']]) {
  el(id).addEventListener('click', () => { settings.mode = mode; changeText(); });
  el(id).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'preset-tab' : event.key === 'End' ? 'custom-tab' : id === 'preset-tab' ? 'custom-tab' : 'preset-tab';
      el(next).click(); el(next).focus();
    }
  });
}
el<HTMLTextAreaElement>('custom-text').addEventListener('input', event => {
  settings.custom = (event.target as HTMLTextAreaElement).value;
  player.stop(true); save();
  el('char-count').textContent = `${settings.custom.length} / 600`;
  renderPlayback();
});
el<HTMLSelectElement>('voice').addEventListener('change', event => { settings.voice = (event.target as HTMLSelectElement).value; changeText(); });
el<HTMLInputElement>('speed').addEventListener('input', event => { settings.speed = Number((event.target as HTMLInputElement).value); changeText(); });
el('speak').addEventListener('click', () => {
  if (player.state === 'playing') return player.pause();
  if (player.state === 'paused') return void player.resume();
  activeText = currentText();
  deliveryMood = inferUtteranceMood(activeText);
  activeTitle = settings.mode === 'presets' ? presets[settings.selected].title : 'A few words of your own';
  void player.speak(activeText, settings.voice, settings.speed);
});
el('stop').addEventListener('click', () => player.stop());
el('download').addEventListener('click', () => player.download());
el('reset-view').addEventListener('click', () => avatar?.reset());
el<HTMLInputElement>('motion').addEventListener('change', event => { settings.motion = (event.target as HTMLInputElement).checked; avatar?.setMotion(settings.motion); save(); });
el<HTMLInputElement>('gestures').addEventListener('change', event => { settings.gestures = (event.target as HTMLInputElement).checked; avatar?.setGestures(settings.gestures); save(); });
const about = el<HTMLDialogElement>('about-dialog');
for (const id of ['about-button', 'engine-info']) el(id).addEventListener('click', () => about.showModal());
el('close-about').addEventListener('click', () => about.close());
about.addEventListener('click', event => { if (event.target === about) { const rect = about.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) about.close(); } });
let healthBusy = false;
async function checkHealth() {
  if (healthBusy) return;
  healthBusy = true;
  try {
    const response = await apiFetch('/api/health', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('offline');
    const body = await response.json();
    health = ['ready', 'loading', 'error', ...(isDeviceOnly ? ['unloaded'] : [])].includes(body.status) ? body.status : 'loading';
    healthMessage = body.status === 'error' ? isDeviceOnly ? body.message || 'The model could not load on this device. Use model setup above to try again.' : 'The voice could not load. Check your internet connection and restart the local app.' : '';
  } catch { health = 'error'; healthMessage = isDeviceOnly ? 'The browser engine could not start. Use model setup above to try again. No words were sent to a server.' : 'The local voice is offline. Start the app with npm run dev, then reconnect.'; }
  finally { healthBusy = false; renderPlayback(); }
}
el('retry').addEventListener('click', () => { if (isDeviceOnly) { el('device-setup').scrollIntoView({ block: 'center' }); el('device-start').focus(); } else void checkHealth(); });
if (isDeviceOnly) window.addEventListener('milo-device-change', () => void checkHealth());
const healthTimer = window.setInterval(() => void checkHealth(), 5000);
let animationFrame = 0;
function updateTrack() {
  const progress = player.duration ? player.currentTime / player.duration : 0;
  if (waveformKey !== player.waveform) {
    waveformKey = player.waveform;
    waveformBars.forEach((bar, i) => { bar.style.height = `${Math.max(3, player.waveform[i] * 32)}px`; });
  }
  waveformBars.forEach((bar, i) => bar.classList.toggle('played', player.hasAudio && i / 64 <= progress));
  el('track-time').innerHTML = `${time(player.currentTime)} <span>/ ${time(player.duration)}</span>`;
  animationFrame = requestAnimationFrame(updateTrack);
}
renderSettings(); void checkHealth(); updateTrack();
window.addEventListener('pagehide', (event) => {
  if (event.persisted) { conversation?.cancel(); player.stop(); return; }
  conversation?.dispose(); devicePanel?.dispose(); clearInterval(healthTimer); cancelAnimationFrame(animationFrame); avatar?.dispose(); player.dispose();
});

import type { ChatMessage, ConversationMemory } from '../conversation-memory';
import { clearStoredModels, holdModelStorage } from './model-storage';
import { codexHealth, usesCodex } from '../reply-provider';

export type DeviceProfile = 'fast' | 'quality' | 'hybrid';
type AudioClient = (typeof import('./audio-client'))['deviceAudio'];
type ChatClient = (typeof import('./chat-client'))['deviceChat'];
let audio: AudioClient | undefined;
let chat: ChatClient | undefined;
let selectedProfile: DeviceProfile = 'fast';
let voiceConsent = false, conversationConsent = false;
let initializingProfile: DeviceProfile | undefined;
let releaseStorage: (() => Promise<void>) | undefined;
let storageRequest: Promise<void> | undefined;
let storageController = new AbortController();
let deleting = false;
let unloadOperation: Promise<void> | undefined;
const approvedProfiles = new Set<DeviceProfile>();
const unloaded = { status: 'unloaded', progress: 0, device: 'cpu', message: 'Choose Download & start to enable this model.' };
const acceleration = { available: false, enabled: false, status: 'unavailable', backend: null, deviceName: null, revision: 0, message: 'Start conversation to check this browser’s GPU. CPU is the default; no server fallback is used.' };

export function setDeviceProfile(profile: DeviceProfile) {
  selectedProfile = profile;
  window.dispatchEvent(new Event('milo-device-change'));
}

export function deviceHealth() {
  const voices = audio?.health() ?? { tts: unloaded, stt: unloaded };
  const mind = chat?.health();
  const approved = approvedProfiles.has(selectedProfile);
  return {
    tts: voices.tts, stt: voices.stt,
    chat: usesCodex() ? codexHealth(selectedProfile) : { ...unloaded, ...mind, status: initializingProfile ? 'loading' : !approved ? 'unloaded' : mind?.status ?? 'unloaded',
      profile: selectedProfile, acceleration: mind?.acceleration ?? acceleration, residency: 'single',
      residencyReason: 'One reply model stays in memory. Hybrid loads the selected model when a turn needs it.' },
  };
}

/** Downloads begin only after the separate, clearly labelled setup action. */
export async function initializeDevice(conversation: boolean, signal: AbortSignal) {
  await unloadOperation;
  if (deleting) throw new Error('Wait for model deletion to finish before starting Milo.');
  const profile = selectedProfile;
  if (!globalThis.isSecureContext || !globalThis.crossOriginIsolated || typeof WebAssembly === 'undefined' || typeof Worker === 'undefined') {
    throw new Error('This browser cannot start local AI here. Use a current desktop browser with a secure connection and cross-origin isolation. Your words will not be sent to a server.');
  }
  signal.throwIfAborted();
  const sessionSignal = AbortSignal.any([signal, storageController.signal]);
  storageRequest ??= holdModelStorage(sessionSignal).then(async release => {
    if (sessionSignal.aborted) { await release(); sessionSignal.throwIfAborted(); }
    releaseStorage = release;
  }).catch(error => { storageRequest = undefined; throw error; });
  await storageRequest;
  sessionSignal.throwIfAborted();
  signal = sessionSignal;
  if (conversation) initializingProfile = profile;
  window.dispatchEvent(new Event('milo-device-change'));
  try {
  audio ??= (await import('./audio-client')).deviceAudio;
  signal.throwIfAborted();
  voiceConsent = true;
  if (!conversation) {
    await audio.initialize('tts', { signal });
  } else {
    if (!usesCodex()) chat ??= (await import('./chat-client')).deviceChat;
    signal.throwIfAborted();
    conversationConsent = true; approvedProfiles.add(profile);
    await audio.initialize('both', { signal });
    signal.throwIfAborted();
    if (!usesCodex()) await chat!.initialize({ profile, signal });
  }
  } finally {
    if (initializingProfile === profile) initializingProfile = undefined;
    window.dispatchEvent(new Event('milo-device-change'));
  }
}

// Changing providers cancels downloads and releases model workers before new work.
window.addEventListener('milo-provider-change', () => { void unloadDevice(); });

export function unloadDevice() {
  return unloadOperation ??= (async () => {
  const pending = storageRequest;
  storageController.abort(); storageController = new AbortController();
  voiceConsent = false; conversationConsent = false; approvedProfiles.clear();
  initializingProfile = undefined;
  await Promise.allSettled([audio?.dispose(), chat?.dispose()]);
  await pending?.catch(() => {});
  await releaseStorage?.(); releaseStorage = undefined; storageRequest = undefined;
  window.dispatchEvent(new Event('milo-device-change'));
  })().finally(() => { unloadOperation = undefined; });
}

export async function deleteDeviceModels() {
  if (deleting) throw new Error('Model deletion is already running.');
  deleting = true;
  try { await unloadDevice(); return await clearStoredModels(); }
  finally { deleting = false; window.dispatchEvent(new Event('milo-device-change')); }
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const consentError = () => json({ message: 'Choose Download & start above to prepare these models on your device. Nothing is sent to a server.' }, 409);

/** API-shaped messages reuse the studio workflow; this function never fetches an API. */
export async function deviceRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const route = path.split('?')[0];
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  if (route === '/api/health') return json({ ...deviceHealth().tts, voices: ['am_michael', 'af_heart', 'bf_emma'] });
  if (route === '/api/conversation/health') return json(deviceHealth());
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  if (route === '/api/conversation/prepare') {
    if (['fast', 'quality', 'hybrid'].includes(body?.profile)) setDeviceProfile(body.profile);
    return json(deviceHealth()); // Merely selecting a tab or model never downloads it.
  }
  if (route === '/api/conversation/acceleration') {
    if (!chat || !conversationConsent || body?.enabled && !approvedProfiles.has(selectedProfile)) return consentError();
    if (typeof body?.enabled !== 'boolean') return json({ message: 'Choose GPU on or off.' }, 400);
    try { await chat.setAcceleration(body.enabled, { signal }); }
    finally { window.dispatchEvent(new Event('milo-device-change')); }
    return json(deviceHealth());
  }
  if (route === '/api/speech') {
    if (!voiceConsent || !audio) return consentError();
    const result = await audio.generate(body, { signal });
    return new Response(result.wav, { headers: { 'Content-Type': 'audio/wav' } });
  }
  if (route === '/api/transcribe') {
    if (!conversationConsent || !audio) return consentError();
    if (!(body instanceof Blob)) return json({ message: 'A recorded voice message is required.' }, 400);
    return json(await audio.transcribe(body, { signal }));
  }
  if (route === '/api/chat/summary' || route === '/api/chat/stream') {
    const profile = body?.profile as DeviceProfile;
    if (!conversationConsent || !approvedProfiles.has(profile) || !chat) return consentError();
    const messages = body.messages as ChatMessage[], memory = body.memory as ConversationMemory;
    if (route === '/api/chat/summary') return json(await chat.summarize(messages, { profile, memory, signal }));
    const controller = new AbortController();
    const replySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        let closed = false;
        const emit = (event: object) => { if (!closed) output.enqueue(encoder.encode(JSON.stringify(event) + '\n')); };
        const abort = () => { if (!closed) { closed = true; output.error(replySignal.reason || new DOMException('Stopped', 'AbortError')); } };
        replySignal.addEventListener('abort', abort, { once: true });
        void chat!.reply(messages, { profile, memory, signal: replySignal,
          onRouting: route => emit({ type: 'routing', ...route }),
          onTextChunk: text => emit({ type: 'delta', text }),
        }).then(result => { if (!replySignal.aborted) emit({ ...result, type: 'done' }); })
          .catch(error => { if (!closed) emit({ type: 'error', message: error instanceof Error ? error.message : 'Milo could not finish on this device. Try Fast mode or free some memory.' }); })
          .finally(() => { replySignal.removeEventListener('abort', abort); if (!closed) { closed = true; output.close(); } });
      },
      cancel() { controller.abort(new DOMException('Stopped', 'AbortError')); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  return json({ message: 'This operation is unavailable in device-only mode.' }, 404);
}

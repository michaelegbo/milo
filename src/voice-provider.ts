import { isDeviceOnly } from './deployment';

/**
 * The hosted voice is Deepgram Flux behind Milo's own origin. The browser
 * only ever talks to /api/voice/, so the API key stays on the server and the
 * content security policy is unchanged. When the proxy is missing, not
 * configured or failing, speech falls back to the on-device Kokoro voice.
 */
export type HostedVoiceStatus = 'unknown' | 'ready' | 'unavailable';
export const PCM_TYPE = 'audio/pcm';
export const HOSTED_VOICE_LABELS: Record<string, string> = { am_michael: 'Bruce · American', af_heart: 'Sienna · American', bf_emma: 'Gemma · British' };
export const DEVICE_VOICE_LABELS: Record<string, string> = { am_michael: 'Michael · American', af_heart: 'Heart · American', bf_emma: 'Emma · British' };

let status: HostedVoiceStatus = isDeviceOnly ? 'unknown' : 'unavailable';
let checkedAt = 0, checking: Promise<HostedVoiceStatus> | undefined;
const RECHECK_MS = 30_000;

export const hostedVoiceStatus = () => status;
export const usesHostedVoice = () => status === 'ready';
export const voiceLabel = (id: string) => (usesHostedVoice() ? HOSTED_VOICE_LABELS : DEVICE_VOICE_LABELS)[id] ?? id;

function update(next: HostedVoiceStatus) {
  checkedAt = Date.now();
  if (next === status) return;
  status = next;
  window.dispatchEvent(new Event('milo-voice-change'));
  window.dispatchEvent(new Event('milo-device-change'));
}

/** Ask the proxy whether Deepgram is configured. Cheap, so it may be repeated after failures. */
export function checkHostedVoice(force = false): Promise<HostedVoiceStatus> {
  if (!isDeviceOnly) return Promise.resolve('unavailable');
  if (checking) return checking;
  if (!force && status !== 'unknown' && Date.now() - checkedAt < RECHECK_MS) return Promise.resolve(status);
  checking = fetch('/api/voice/health', { credentials: 'omit', signal: AbortSignal.timeout(6000) })
    .then(async response => { const body = response.ok ? await response.json() : {}; update(body?.status === 'ready' ? 'ready' : 'unavailable'); })
    .catch(() => update('unavailable'))
    .then(() => status)
    .finally(() => { checking = undefined; });
  return checking;
}

/** Stream one sentence from the hosted voice. Throws so the caller can fall back. */
export async function hostedSpeak(body: { text: string; voice?: string }, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch('/api/voice/speak', {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body.text, voice: body.voice }), signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    update('unavailable');
    throw new Error('The hosted voice could not be reached.');
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    // Quota and validation problems are per request; anything else means the proxy is down for now.
    if (response.status !== 429 && response.status !== 400) update('unavailable');
    throw new Error(result.message || 'The hosted voice could not speak that sentence.');
  }
  return response;
}

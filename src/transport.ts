import { isDeviceOnly } from './deployment';
import { codexHealth, codexReply, usesCodex } from './reply-provider';
import { checkHostedVoice, hostedSpeak, hostedVoiceStatus, usesHostedVoice } from './voice-provider';

let codexProfile = 'fast';
/** Local inference is the default. Only an explicitly selected provider can send text. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (usesCodex() && ['/api/chat/stream', '/api/chat/summary'].includes(path)) return codexReply(path, init);
  if (usesCodex() && path === '/api/conversation/prepare') {
    const body = JSON.parse(String(init?.body || '{}')); codexProfile = body.profile || 'fast';
    if (!isDeviceOnly) init = { ...init, body: JSON.stringify({ ...body, provider: 'codex' }) };
  }
  if (isDeviceOnly && path === '/api/speech') {
    if (hostedVoiceStatus() === 'unknown') await checkHostedVoice();
    if (usesHostedVoice()) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      try { return await hostedSpeak(body, init?.signal ?? undefined); }
      catch (error) {
        if (init?.signal?.aborted) throw error;
        // The proxy is down or over quota: continue with Kokoro when it is loaded, otherwise say what to do.
        if (!(await import('./device/transport')).deviceVoiceReady()) return Response.json({ message: `${(error as Error).message} Download the on-device voice above to keep talking.` }, { status: 503 });
      }
    }
  }
  const response = isDeviceOnly ? await (await import('./device/transport')).deviceRequest(path, init) : await fetch(path, init);
  if (usesCodex() && ['/api/conversation/health', '/api/conversation/prepare'].includes(path) && response.ok) {
    const health = await response.json();
    return Response.json({ ...health, chat: codexHealth(isDeviceOnly ? health.chat.profile : codexProfile) });
  }
  return response;
}

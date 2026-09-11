import { isDeviceOnly } from './deployment';
import { codexHealth, codexReply, usesCodex } from './reply-provider';
import { checkHostedVoice, DEEPGRAM_UNAVAILABLE, hostedSpeak, hostedVoiceStatus } from './voice-provider';

let codexProfile = 'quality';
/** Local inference is the default. Only an explicitly selected provider can send text. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (usesCodex() && ['/api/chat/stream', '/api/chat/summary'].includes(path)) return codexReply(path, init);
  if (usesCodex() && path === '/api/conversation/prepare') {
    const body = JSON.parse(String(init?.body || '{}')); codexProfile = body.profile || 'fast';
    if (!isDeviceOnly) init = { ...init, body: JSON.stringify({ ...body, provider: 'codex' }) };
  }
  if (isDeviceOnly && path === '/api/speech') {
    // The browser edition speaks only with Deepgram. If it cannot, Milo stays silent and says why.
    const unavailable = (message = DEEPGRAM_UNAVAILABLE) => Response.json({ message }, { status: 503 });
    if (hostedVoiceStatus() !== 'ready' && (await checkHostedVoice(true)) !== 'ready') return unavailable();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const signal = init?.signal ?? undefined;
    try { return await hostedSpeak(body, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      // A restarting proxy or a dropped connection deserves one quick retry before anyone is told anything.
      if ((await checkHostedVoice(true)) === 'ready') {
        try { return await hostedSpeak(body, signal); }
        catch (again) { if (signal?.aborted) throw again; if (hostedVoiceStatus() === 'ready') return unavailable(again instanceof Error ? again.message : undefined); }
      }
      return unavailable();
    }
  }
  const response = isDeviceOnly ? await (await import('./device/transport')).deviceRequest(path, init) : await fetch(path, init);
  if (usesCodex() && ['/api/conversation/health', '/api/conversation/prepare'].includes(path) && response.ok) {
    const health = await response.json();
    return Response.json({ ...health, chat: codexHealth(isDeviceOnly ? health.chat.profile : codexProfile) });
  }
  return response;
}

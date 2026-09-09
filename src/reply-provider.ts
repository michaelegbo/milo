export type ReplyProvider = 'device' | 'codex';
export type CodexStatus = { connected: boolean; signedIn: boolean; plan?: string; loginPending?: boolean; loginError?: string; login?: { verificationUrl: string; userCode: string; expiresAt: number } | null; models: { id: string; name: string; isDefault: boolean }[] };
let provider: ReplyProvider = 'device', model = '', status: CodexStatus | undefined, epoch = 0;
// Remove credentials from the superseded local-companion implementation.
try { sessionStorage.removeItem('milo-companion-pairing'); } catch { /* Optional storage. */ }
export const usesCodex = () => provider === 'codex';
export const codexStatus = () => status;
export const codexModel = () => model;
export function selectCodexModel(value: string) { model = value; }
export function selectReplyProvider(value: ReplyProvider) {
  provider = value; epoch++;
  window.dispatchEvent(new Event('milo-provider-change'));
  window.dispatchEvent(new Event('milo-device-change'));
}
export function updateCodexStatus(value: CodexStatus) {
  status = value;
  if (!value.models.some(m => m.id === model)) model = value.models.find(m => m.isDefault)?.id ?? value.models[0]?.id ?? '';
  window.dispatchEvent(new Event('milo-device-change'));
}
export function disconnectCodex() { status = undefined; model = ''; selectReplyProvider('device'); }
export async function codexRequest(route: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch('/api/codex' + route, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(35_000) }).catch(error => {
      if (signal?.aborted) throw error;
      throw new Error('ChatGPT connection is unavailable. Check your connection and try again.');
    });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) { status = undefined; window.dispatchEvent(new Event('milo-device-change')); }
    throw new Error(result.message || 'ChatGPT could not complete that request. Please retry.');
  }
  return response;
}
export async function refreshCodex() {
  const current = epoch;
  try { const result = await (await codexRequest('/status')).json(); if (current === epoch) updateCodexStatus(result); }
  catch (error) { if (current === epoch) { status = undefined; window.dispatchEvent(new Event('milo-device-change')); } throw error; }
}
export function codexHealth(profile: string) {
  return { status: status?.signedIn && model ? 'ready' : 'unloaded', profile, progress: 0,
    message: status?.signedIn ? 'Replies use your ChatGPT account. Voice stays on your device.' : 'Connect to ChatGPT to enable replies.',
    acceleration: { available: false, enabled: false, status: 'unavailable', backend: null, deviceName: null, revision: 0, message: 'ChatGPT replies run at OpenAI. Your GPU setting applies to local replies.' } };
}
export async function codexReply(path: string, init: RequestInit = {}) {
  if (!usesCodex() || !status?.signedIn || !model) throw new Error('Connect to ChatGPT first.');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  return codexRequest(path.endsWith('/summary') ? '/summary' : '/chat', { ...body, model }, init.signal ?? undefined);
}

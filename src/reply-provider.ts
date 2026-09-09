export type ReplyProvider = 'device' | 'codex';
type Status = { connected: boolean; signedIn: boolean; plan?: string; loginPending?: boolean; loginError?: string; models: { id: string; name: string; isDefault: boolean }[] };
const endpoint = 'http://127.0.0.1:8790';
let provider: ReplyProvider = 'device';
let token = '', model = '', status: Status | undefined;
let epoch = 0;
try { token = sessionStorage.getItem('milo-companion-pairing') || ''; } catch { /* Pairing can remain in memory. */ }
export const usesCodex = () => provider === 'codex';
export const codexStatus = () => status;
export const codexModel = () => model;
export function selectCodexModel(value: string) { model = value; }
export function selectReplyProvider(value: ReplyProvider) {
  provider = value; epoch++;
  window.dispatchEvent(new Event('milo-provider-change'));
  window.dispatchEvent(new Event('milo-device-change'));
}
export function pairCompanion(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value.trim())) throw new Error('Paste the 64-character pairing code shown by the Milo companion.');
  token = value.trim(); epoch++; status = undefined;
  try { sessionStorage.setItem('milo-companion-pairing', token); } catch { /* In-memory pairing still works. */ }
}
export function disconnectCompanion() {
  token = ''; status = undefined; model = ''; epoch++;
  try { sessionStorage.removeItem('milo-companion-pairing'); } catch { /* Nothing persisted. */ }
  selectReplyProvider('device');
}
export async function companionRequest(route: string, body?: unknown, signal?: AbortSignal) {
  if (!token) throw new Error('Start the Milo companion and paste its pairing code first.');
  const response = await fetch(endpoint + route, { method: body === undefined ? 'GET' : 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(35_000) }).catch(error => {
      if (signal?.aborted) throw error;
      throw new Error('Cannot reach your Milo companion. Start it on this computer, allow local-network access if prompted, then reconnect.');
    });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.message || 'The companion could not complete that request.');
  }
  return response;
}
export async function refreshCodex() {
  const current = epoch;
  try {
    const result: Status = await (await companionRequest('/status')).json();
    if (current !== epoch) return;
    status = result;
    if (!result.models.some(m => m.id === model)) model = result.models.find(m => m.isDefault)?.id ?? result.models[0]?.id ?? '';
  } catch (error) { if (current === epoch) status = undefined; throw error; }
  finally { if (current === epoch) window.dispatchEvent(new Event('milo-device-change')); }
}
export function codexHealth(profile: string) {
  return { status: status?.signedIn && model ? 'ready' : 'unloaded', profile, progress: 0,
    message: status?.signedIn ? 'Replies use your ChatGPT account. Voice stays on your device.' : 'Connect the companion and sign in to ChatGPT.',
    acceleration: { available: false, enabled: false, status: 'unavailable', backend: null, deviceName: null, revision: 0, message: 'ChatGPT replies run at OpenAI. Your GPU setting applies to local replies.' } };
}
export async function codexReply(path: string, init: RequestInit = {}) {
  if (!usesCodex() || !status?.signedIn || !model) throw new Error('Connect the Milo companion and sign in to ChatGPT first.');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  return companionRequest(path.endsWith('/summary') ? '/summary' : '/chat', { ...body, model }, init.signal ?? undefined);
}

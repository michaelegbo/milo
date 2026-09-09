import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHostedCodex } from './codex-hosted.mjs';

class FakeClient extends EventEmitter {
  constructor(directory) { super(); this.directory = directory; this.calls = []; this.signedIn = false; this.stopped = false; this.hold = false; }
  async start() { if (this.started) return; this.started = true; this.stopped = false; this.signedIn = await readFile(path.join(this.directory, 'test-auth'), 'utf8').then(() => true).catch(() => false); }
  async shutdown() { this.started = false; this.stopped = true; this.emit('unavailable'); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.signedIn ? { type: 'chatgpt', email: 'private@example.test', planType: 'plus' } : null };
    if (method === 'model/list') return { data: [{ model: 'available', displayName: 'Available model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: null };
    if (method === 'account/login/start') return { loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' };
    return {};
  }
  async reply(options) {
    this.lastReply = options; options.onText('Hello.');
    if (this.hold) await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { this.aborted = true; reject(options.signal.reason); }, { once: true }); });
    return 'Hello.';
  }
}
const body = { profile: 'hybrid', model: 'available', messages: [{ role: 'user', content: 'Explain this idea' }], memory: { summary: '', facts: [] } };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'milo-hosted-test-'));
  const clients = [];
  const config = { directory, port: 0, origin: 'https://milo.seemplifyai.com', clientFactory: dir => { const c = new FakeClient(dir); clients.push(c); return c; }, ...options };
  let app = await createHostedCodex(config); await app.listen();
  t.after(async () => { await app.close(); if (path.dirname(directory) !== path.resolve(tmpdir())) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); });
  const request = (route, data, cookie, headers = {}) => fetch(`http://127.0.0.1:${app.server.address().port}/api/codex${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { clients, directory, request, app, restart: async () => { await app.close(); app = await createHostedCodex(config); await app.listen(); },
    login: async () => { const r = await request('/login', {}); assert.equal(r.status, 200); return { cookie: r.headers.get('set-cookie').split(';')[0], data: await r.json(), fullCookie: r.headers.get('set-cookie') }; } };
}
test('anonymous status never spawns Codex; cookie mutations require exact origin and JSON', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.request('/status')).json()).signedIn, false); assert.equal(f.clients.length, 0);
  assert.equal((await f.request('/login', {}, null, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request('/login', {}, null, { Origin: '', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/login', {}, null, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/chat', body)).status, 401);
  assert.equal((await f.request('/rpc', {})).status, 404); assert.equal(f.clients.length, 0);
});
test('website device login resumes, uses secure HttpOnly cookies, and never returns credentials', async t => {
  const f = await fixture(t), login = await f.login();
  assert.match(login.fullCookie, /__Host-milo-codex=.*HttpOnly; SameSite=Strict;.*Secure/);
  assert.equal(login.data.login.userCode, 'TEST-CODE');
  assert.equal(f.clients[0].calls.find(c => c.method === 'account/login/start').params.type, 'chatgptDeviceCode');
  await f.request('/login', {}, login.cookie); assert.equal(f.clients[0].calls.filter(c => c.method === 'account/login/start').length, 1);
  await f.request('/login/cancel', {}, login.cookie);
  assert.equal((await (await f.request('/status', undefined, login.cookie)).json()).loginPending, false);
  f.clients[0].signedIn = true;
  const status = await (await f.request('/status', undefined, login.cookie)).json();
  assert.equal(status.models[0].id, 'available'); assert.equal(JSON.stringify(status).includes('private@example.test'), false);
});
test('two visitors have isolated credentials, replies, and disconnect cleanup', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login();
  assert.notEqual(a.cookie, b.cookie); assert.notEqual(f.clients[0].directory, f.clients[1].directory);
  f.clients[0].signedIn = true;
  assert.equal((await (await f.request('/status', undefined, b.cookie)).json()).signedIn, false);
  assert.equal((await f.request('/chat', body, b.cookie)).status, 401);
  const res = await f.request('/chat', body, a.cookie); const events = (await res.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.type), ['routing', 'delta', 'done']); assert.equal(f.clients[0].lastReply.effort, 'high');
  assert.equal((await f.request('/chat', { ...body, model: 'other' }, a.cookie)).status, 400);
  await f.request('/logout', {}, a.cookie);
  assert.equal(f.clients[0].stopped, true); assert.equal((await readdir(f.directory)).length, 1);
  assert.equal((await (await f.request('/status', undefined, a.cookie)).json()).signedIn, false);
  assert.equal((await (await f.request('/status', undefined, b.cookie)).json()).loginPending, true);
});
test('browser cookie reconnects its stored account after a backend restart; forged cookies do not', async t => {
  const f = await fixture(t), login = await f.login();
  await writeFile(path.join(f.clients[0].directory, 'test-auth'), 'test-only');
  await f.restart();
  assert.equal((await (await f.request('/status', undefined, login.cookie)).json()).signedIn, true);
  assert.equal((await (await f.request('/status', undefined, '__Host-milo-codex=' + 'f'.repeat(64))).json()).signedIn, false);
});
test('resident and persistent admission are bounded, with idle worker eviction', async t => {
  const f = await fixture(t, { maxResidents: 1, maxSessions: 2 }), a = await f.login();
  assert.equal((await f.request('/login', {})).status, 503);
  await f.request('/login/cancel', {}, a.cookie);
  // A capacity-rejected request already received its own cookie; use it to retry.
  await f.request('/logout', {}, a.cookie);
  const b = await f.login(); assert.equal(b.data.loginPending, true);
  assert.ok(f.clients.length <= 2);
});
test('stopping a stream aborts only its own visitor turn; oversized input is rejected', async t => {
  const f = await fixture(t), a = await f.login(); f.clients[0].signedIn = true; f.clients[0].hold = true;
  const res = await f.request('/chat', body, a.cookie);
  assert.equal((await f.request('/chat', body, a.cookie)).status, 409);
  await res.body.cancel(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.clients[0].aborted, true);
  assert.equal((await f.request('/chat', { garbage: 'x'.repeat(25000) }, a.cookie)).status, 413);
});
test('expired sessions cannot recover or access another stored account', async t => {
  const f = await fixture(t, { ttl: 40 }), login = await f.login();
  f.clients[0].signedIn = true; await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await f.request('/chat', body, login.cookie)).status, 401);
  await f.restart(); assert.equal((await readdir(f.directory)).length, 0);
});

test('logout waits for a concurrent startup and revokes the cookie before cleanup', async t => {
  const f = await fixture(t), a = await f.login();
  const client = f.clients[0];
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  client.start = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const pendingStatus = f.request('/status', undefined, a.cookie);
  await waiting;
  const pendingLogout = f.request('/logout', {}, a.cookie);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await (await f.request('/status', undefined, a.cookie)).json()).signedIn, false);
  release(); await pendingStatus;
  assert.equal((await pendingLogout).status, 200);
  assert.equal(client.stopped, true); assert.equal((await readdir(f.directory)).length, 0);
});

test('failed process shutdown keeps a revoked tombstone for restart cleanup', async t => {
  const f = await fixture(t), a = await f.login();
  f.clients[0].shutdown = async () => { throw new Error('test process did not exit'); };
  assert.equal((await f.request('/logout', {}, a.cookie)).status, 502);
  assert.equal((await (await f.request('/status', undefined, a.cookie)).json()).signedIn, false);
  assert.equal(JSON.parse(await readFile(path.join(f.clients[0].directory, 'session.json'), 'utf8')).expires, 0);
  await f.restart();
  assert.equal((await readdir(f.directory)).length, 0);
});

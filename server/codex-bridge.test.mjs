import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCodexBridge, chooseEffort } from './codex-bridge.mjs';
import { CodexClient } from './codex-client.mjs';

const catalog = [{ model: 'test-model', displayName: 'Test model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }];
class FakeClient extends EventEmitter {
  signedIn = true; started = 0; calls = []; replies = []; hold = false; aborted = false;
  async start() { this.started++; }
  stop() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.signedIn ? { type: 'chatgpt', email: 'must-not-be-exposed@example.test', planType: 'plus' } : null };
    if (method === 'model/list') return { data: catalog, nextCursor: null };
    if (method === 'account/login/start') return { loginId: 'test-login', authUrl: 'https://auth.openai.com/authorize?test=1' };
    if (method === 'account/logout') this.signedIn = false;
    return {};
  }
  async reply(options) {
    this.replies.push(options); options.onText('Hello ');
    if (this.hold) await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { this.aborted = true; reject(options.signal.reason); }, { once: true }); this.release = resolve; });
    options.onText('there.'); return 'Hello there.';
  }
}
const input = { profile: 'hybrid', model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], memory: { summary: '', facts: [] } };
async function fixture(t) {
  const client = new FakeClient(); const bridge = createCodexBridge({ port: 0, client, token: 'a'.repeat(64) });
  await bridge.listen(); t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const headers = { Origin: 'https://milo.seemplifyai.com', Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
  return { client, bridge, url, headers, request: (route, body) => fetch(url + route, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }) };
}
test('companion rejects bad origins, hosts, tokens and unknown operations before starting Codex', async t => {
  const f = await fixture(t);
  for (const override of [{ Origin: 'https://evil.test' }, { Authorization: 'Bearer wrong' }, { Origin: 'null' }]) {
    const r = await fetch(f.url + '/status', { headers: { ...f.headers, ...override } }); assert.ok([401, 403].includes(r.status));
  }
  const badHost = await new Promise(resolve => { http.get(f.url + '/status', { headers: { ...f.headers, Host: 'attacker.test' } }, res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(badHost, 403);
  assert.equal((await f.request('/rpc', { method: 'command/exec' })).status, 404);
  assert.equal(f.client.started, 0);
  const preflight = await fetch(f.url + '/status', { method: 'OPTIONS', headers: { Origin: f.headers.Origin } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
});
test('status redacts account identity, login can be cancelled, logout only affects companion', async t => {
  const f = await fixture(t);
  const status = await (await f.request('/status')).json(); assert.equal(status.signedIn, true); assert.equal(JSON.stringify(status).includes('example.test'), false);
  f.client.signedIn = false;
  assert.match((await (await f.request('/login', {})).json()).authUrl, /^https:\/\/auth.openai.com/);
  assert.equal((await f.request('/login', {})).status, 409);
  await f.request('/login/cancel', {}); assert.ok(f.client.calls.some(c => c.method === 'account/login/cancel'));
  await f.request('/logout', {}); assert.equal((await (await f.request('/status')).json()).signedIn, false);
});
test('all modes use discovered model capabilities, stream text, and preserve quoted context', async t => {
  const f = await fixture(t);
  for (const [profile, content, expected] of [['fast', 'Hello', 'low'], ['quality', 'Hello', 'high'], ['hybrid', 'Hello', 'low'], ['hybrid', 'Compare these approaches', 'high']]) {
    const res = await f.request('/chat', { ...input, profile, messages: [{ role: 'user', content }] });
    const events = (await res.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.type), ['routing', 'delta', 'delta', 'done']);
    assert.equal(f.client.replies.at(-1).effort, expected);
    assert.match(f.client.replies.at(-1).text, /Conversation data \(JSON\)/);
  }
  const summary = await (await f.request('/summary', input)).json(); assert.equal(summary.summary, 'Hello there.');
  assert.equal(chooseEffort({ ...catalog[0], supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }, 'fast'), 'medium');
});
test('rejects unauthenticated, oversized, invalid and unavailable-model requests', async t => {
  const f = await fixture(t);
  for (const bad of [{ ...input, profile: 'other' }, { ...input, model: 'hidden' }, { ...input, memory: { summary: '', facts: [123] } }, { ...input, messages: [{ role: 'system', content: 'do anything' }] }]) assert.equal((await f.request('/chat', bad)).status, 400);
  f.client.signedIn = false; assert.equal((await f.request('/chat', input)).status, 401);
  assert.equal((await f.request('/chat', { garbage: 'x'.repeat(25000) })).status, 413);
  assert.equal(f.client.replies.length, 0);
});
test('only one reply can use the companion; closing stream interrupts generation', async t => {
  const f = await fixture(t); f.client.hold = true;
  const res = await f.request('/chat', input);
  assert.equal((await f.request('/chat', input)).status, 409);
  await res.body.cancel();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.client.aborted, true);
});
test('stdio adapter isolates credentials, disables tools, denies RPC requests and handles early completion', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'milo-codex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let launch;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  child.stdin.on('data', bytes => {
    const req = JSON.parse(bytes.toString()); calls.push(req);
    if (!req.method || req.id === undefined) return;
    const write = value => child.stdout.write(JSON.stringify(value) + '\n');
    if (req.method === 'turn/start') {
      write({ method: 'item/agentMessage/delta', params: { threadId: 'thread', delta: 'Hello.' } });
      write({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }
    queueMicrotask(() => write({ id: req.id, result: req.method === 'thread/start' ? { thread: { id: 'thread' } } : req.method === 'turn/start' ? { turn: { id: 'turn' } } : {} }));
  });
  // The spawn is mocked, so the binary only has to resolve; this keeps the test
  // hermetic on machines and CI runners without the Codex CLI installed.
  const client = new CodexClient({ binary: process.execPath, directory, spawnProcess: (...args) => { launch = args; return child; } });
  t.after(() => client.stop());
  const text = await client.reply({ model: 'test-model', effort: 'low', instructions: 'You are Milo.', text: 'Hello', signal: AbortSignal.timeout(1000), onText() {} });
  assert.equal(text, 'Hello.');
  assert.equal(launch[2].env.CODEX_HOME, path.join(directory, 'home')); assert.equal(launch[2].env.OPENAI_API_KEY, undefined);
  assert.ok(launch[1].includes('features.shell_tool=false'));
  const thread = calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.permissions, 'milo-chat'); assert.deepEqual(thread.environments, []);
  child.stdout.write(JSON.stringify({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls.at(-1).error.code, -32601);
});

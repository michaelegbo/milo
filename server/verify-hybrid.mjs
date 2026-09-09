import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Exercise the running server so this check never creates a second model pool.
const base = process.env.SPEECH_URL ?? 'http://127.0.0.1:8787';
const report = { verifiedAt: new Date().toISOString(), turns: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const health = async () => {
  const response = await fetch(`${base}/api/conversation/health`);
  assert.equal(response.status, 200);
  return response.json();
};
const post = (path, body, signal = AbortSignal.timeout(150_000)) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});
async function waitReady(mode, timeout = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const current = await health();
    for (const engine of [current.chat, current.stt, current.tts]) assert.notEqual(engine.status, 'error', engine.message);
    if (current.chat.profile === mode && current.chat.status === 'ready' && current.chat.queueDepth === 0
      && current.stt.status === 'ready' && current.tts.status === 'ready') return current;
    await delay(500);
  }
  throw new Error(`Timed out preparing ${mode}`);
}
async function stream(messages, memory, expectedProfile, { controller, cancelAtDelta = false } = {}) {
  const started = performance.now();
  const response = await post('/api/chat/stream', { profile: 'hybrid', messages, memory }, controller?.signal);
  assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = [];
  let firstDeltaMs;
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter(line => line.trim())) {
        const event = JSON.parse(line);
        assert.notEqual(event.type, 'error', event.message);
        events.push(event);
        if (event.type === 'delta') {
          firstDeltaMs ??= Math.round(performance.now() - started);
          assert.equal(events[0].type, 'routing');
          assert.equal(events[0].profile, expectedProfile);
          if (cancelAtDelta) {
            controller.abort();
            await reader.cancel().catch(() => {});
            return { cancelled: true, route: events[0], firstDeltaMs };
          }
        }
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  assert.equal(buffer.trim(), '');
  assert.equal(events[0].type, 'routing');
  assert.equal(events[0].profile, expectedProfile);
  assert.equal(typeof events[0].reason, 'string');
  assert.equal(events.filter(event => event.type === 'routing').length, 1);
  assert.equal(events.filter(event => event.type === 'done').length, 1);
  const result = events.at(-1);
  assert.equal(result.type, 'done');
  assert.equal(result.profile, expectedProfile);
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.device, 'cpu');
  const deltas = events.filter(event => event.type === 'delta');
  assert(deltas.length > 1);
  assert.equal(deltas.map(event => event.text).join(''), result.text);
  assert(result.text.length > 0 && result.text.length <= 600);
  const current = (await health()).chat;
  assert.equal(current.profile, 'hybrid');
  assert.equal(current.selectedModel, expectedProfile);
  return { route: events[0], firstDeltaMs, completeMs: Math.round(performance.now() - started), result, health: current };
}

const prepare = await post('/api/conversation/prepare', { profile: 'hybrid' });
assert.equal(prepare.status, 202, await prepare.text());
report.prepared = (await waitReady('hybrid')).chat;
console.log(JSON.stringify({ stage: 'prepared', health: report.prepared }));
const memory = { summary: '', facts: ['The user lives in Bristol.', 'The user is learning guitar.'] };
const messages = [];
for (const [content, expectedProfile] of [
  ['Hello Milo!', 'fast'],
  ['Where do I live and what am I learning? Explain one advantage of practising little and often versus once a week.', 'quality'],
  ['Thanks Milo!', 'fast'],
]) {
  messages.push({ role: 'user', content });
  const turn = await stream(messages, memory, expectedProfile);
  if (expectedProfile === 'quality') {
    assert.match(turn.result.text, /Bristol/i);
    assert.match(turn.result.text, /guitar/i);
  }
  messages.push({ role: 'assistant', content: turn.result.text });
  report.turns.push({ prompt: content, ...turn });
  console.log(JSON.stringify({ prompt: content, profile: turn.result.profile, firstDeltaMs: turn.firstDeltaMs, completeMs: turn.completeMs, text: turn.result.text }));
}
report.cancellation = await stream([{ role: 'user', content: 'Compare electric and acoustic guitars for a beginner.' }], memory, 'quality', { controller: new AbortController(), cancelAtDelta: true });
report.recovery = await stream([{ role: 'user', content: 'Hello again!' }], memory, 'fast');
report.finished = (await waitReady('hybrid')).chat;
if (report.prepared.residency === 'dual') {
  assert.equal(report.finished.residency, 'dual');
  for (const profile of ['fast', 'quality']) {
    assert.equal(report.finished.residentModels[profile].status, 'ready');
    if (report.prepared.residentModels[profile].loadCount != null) {
      assert.equal(report.finished.residentModels[profile].loadCount, report.prepared.residentModels[profile].loadCount, `${profile} reloaded between turns`);
    }
  }
}
const invalid = await post('/api/chat/stream', { profile: 'hybrid', messages: [] });
assert.equal(invalid.status, 400);
assert.equal((await invalid.json()).error, 'invalid_messages');
report.invalidBeforeStream = true;
const directory = new URL('./verification/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('hybrid-report.json', directory), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, residency: report.finished.residency, cancellationAndRecovery: true }));

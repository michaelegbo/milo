import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Uses the running Milo server; never starts a competing inference pool.
const base = process.env.SPEECH_URL ?? 'http://127.0.0.1:8787';
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
const health = async () => (await (await fetch(`${base}/api/conversation/health`)).json()).chat;
async function waitFor(predicate, timeout = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await health();
    if (predicate(value)) return value;
    await delay(150);
  }
  throw new Error('Timed out waiting for the requested execution state.');
}
async function prepare(profile) {
  const response = await post('/api/conversation/prepare', { profile });
  assert.equal(response.status, 202, await response.text());
  return waitFor(value => value.profile === profile && value.status === 'ready' && value.queueDepth === 0);
}
async function switchDevice(enabled, wait = true) {
  const response = await post('/api/conversation/acceleration', { enabled });
  assert.equal(response.status, 202, await response.text());
  if (!wait) return;
  const result = await waitFor(value => value.acceleration.enabled === enabled && value.acceleration.status !== 'switching' && value.status === 'ready');
  assert.equal(result.device, enabled ? 'gpu' : 'cpu');
  return result;
}
async function gpuMemory() {
  try {
    const { stdout } = await execute('nvidia-smi', ['--query-gpu=name,memory.used,memory.free', '--format=csv,noheader'], { windowsHide: true, timeout: 5000 });
    return stdout.trim();
  } catch { return null; }
}
async function reply(profile, messages, memory, { onFirstDelta } = {}) {
  const started = performance.now();
  const response = await post('/api/chat/stream', { profile, messages, memory });
  assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '', firstDeltaMs;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter(line => line.trim())) {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === 'delta' && firstDeltaMs == null) {
          firstDeltaMs = Math.round(performance.now() - started);
          await onFirstDelta?.();
        }
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  const completed = events.find(event => event.type === 'done');
  const error = events.find(event => event.type === 'error');
  if (!onFirstDelta) {
    assert(!error, error?.message);
    assert(completed?.text);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), completed.text);
    assert.equal(events.at(-1)?.type, 'done');
  }
  return { firstDeltaMs, completeMs: Math.round(performance.now() - started), result: completed ?? null, error: error ?? null, route: events.find(event => event.type === 'routing') ?? null, events };
}

const report = { verifiedAt: new Date().toISOString() };
const detected = await waitFor(value => value.acceleration && value.acceleration.status !== 'detecting');
assert(detected.acceleration.available, detected.acceleration.message);
report.detected = detected.acceleration;
if (detected.acceleration.enabled) await switchDevice(false);
await prepare('quality');
report.beforeGpu = await gpuMemory();
const memory = { summary: '', facts: ['The user is named Amara.', 'The user lives in Bristol.'] };
const messages = [{ role: 'user', content: 'What is my name and where do I live? Explain one advantage of practising a skill little and often.' }];
report.cpu = await reply('quality', messages, memory);
assert.equal(report.cpu.result.device, 'cpu');
assert.match(report.cpu.result.text, /Amara/i);
assert.match(report.cpu.result.text, /Bristol/i);
console.log(JSON.stringify({ stage: 'cpu-baseline', firstDeltaMs: report.cpu.firstDeltaMs, completeMs: report.cpu.completeMs }));
const gpuLoadingStarted = performance.now();
report.gpuReady = await switchDevice(true);
report.gpuLoadMs = Math.round(performance.now() - gpuLoadingStarted);
assert.equal(report.gpuReady.profile, 'quality');
assert(report.gpuReady.gpuLayers > 0 || report.gpuReady.residentModels?.quality?.gpuLayers > 0);
report.duringGpu = await gpuMemory();
report.gpu = await reply('quality', messages, memory);
assert.equal(report.gpu.result.device, 'gpu');
assert.match(report.gpu.result.text, /Amara/i);
assert.match(report.gpu.result.text, /Bristol/i);
console.log(JSON.stringify({ stage: 'gpu', firstDeltaMs: report.gpu.firstDeltaMs, completeMs: report.gpu.completeMs, text: report.gpu.result.text }));
await prepare('hybrid');
report.hybridPrepared = await health();
report.hybrid = [];
const history = [];
for (const [content, expected] of [['Hello Milo!', 'fast'], ['What is my name and where do I live?', 'quality'], ['Thanks Milo!', 'fast']]) {
  history.push({ role: 'user', content });
  const turn = await reply('hybrid', history, memory);
  assert.equal(turn.route?.profile, expected);
  assert.equal(turn.result.profile, expected);
  assert.equal(turn.result.mode, 'hybrid');
  assert.equal(turn.result.device, expected === 'fast' ? 'cpu' : 'gpu');
  assert.equal(turn.events[0].type, 'routing');
  history.push({ role: 'assistant', content: turn.result.text });
  report.hybrid.push(turn);
  console.log(JSON.stringify({ stage: 'hybrid', profile: expected, firstDeltaMs: turn.firstDeltaMs, completeMs: turn.completeMs }));
}
report.hybridFinished = await health();
if (report.hybridPrepared.residency === 'dual') {
  assert.equal(report.hybridFinished.residency, 'dual');
  for (const name of ['fast', 'quality']) assert.equal(report.hybridFinished.residentModels[name].loadCount, report.hybridPrepared.residentModels[name].loadCount, `${name} reloaded during mixed Hybrid handoff`);
}
// Turn OFF while a real GPU response is arriving. Already-emitted words may
// remain readable; an unfinished GPU stream must be cancelled or already done.
report.interrupted = await reply('hybrid', [{ role: 'user', content: 'Compare learning a language by reading books, taking lessons, and practising conversation. Explain their strengths and weaknesses.' }], memory, { onFirstDelta: () => switchDevice(false, false) });
report.cpuRestored = await waitFor(value => !value.acceleration.enabled && value.acceleration.status !== 'switching' && value.status === 'ready');
assert.equal(report.cpuRestored.profile, 'hybrid');
assert.equal(report.cpuRestored.device, 'cpu');
for (const resident of Object.values(report.cpuRestored.residentModels)) assert.notEqual(resident.device, 'gpu');
report.afterGpu = await gpuMemory();
const gpuProcessId = report.gpuReady.residentModels?.quality?.processId;
if (gpuProcessId && new URL(base).hostname === '127.0.0.1') {
  let exited = false;
  try { process.kill(gpuProcessId, 0); }
  catch (error) { if (error.code === 'ESRCH') exited = true; else throw error; }
  assert(exited, 'The retired GPU process is still running after CPU readiness.');
  report.gpuProcessExited = true;
}
report.recovery = await reply('hybrid', [{ role: 'user', content: 'Hello again!' }], memory);
assert.equal(report.recovery.result.device, 'cpu');
const invalid = await post('/api/conversation/acceleration', { enabled: 'yes' });
assert.equal(invalid.status, 400);
report.invalidInputRejected = true;
report.sameModel = report.cpu.result.model === report.gpu.result.model;
assert(report.sameModel);
report.observedReplySpeedup = Number((report.cpu.completeMs / report.gpu.completeMs).toFixed(2));
const directory = new URL('./verification/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('acceleration-report.json', directory), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, observedReplySpeedup: report.observedReplySpeedup, cpuRestored: true, before: report.beforeGpu, during: report.duringGpu, after: report.afterGpu }));

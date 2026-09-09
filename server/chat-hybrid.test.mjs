import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatEngine } from './chat-engine.mjs';
import { ChatError } from './chat-config.mjs';
import { routeHybrid } from './chat-router.mjs';
import { canAdmitModels } from './chat-memory-budget.mjs';

const GiB = 1024 ** 3;
const user = content => [{ role: 'user', content }];
const budget = gib => ({ freeBytes: gib * GiB, commitFreeBytes: gib * GiB, reliable: true });
async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await delay(5); }
  assert.fail('Timed out waiting for the fake engine lifecycle.');
}

function harness({ gpu, memory = () => budget(30), failQuality = false, loadMs = 5, replyMs = 20, cancelMs = 35, terminationMs = 0 } = {}) {
  const log = [];
  const instances = [];
  const states = new Map();
  let running = 0;
  let peak = 0;
  let gpuResidents = 0;
  let peakGpuResidents = 0;
  const begin = label => { log.push(`start:${label}`); running++; peak = Math.max(peak, running); };
  const end = label => { log.push(`end:${label}`); running--; };
  const engine = createChatEngine({
    gpu,
    readMemory: async () => { log.push('memory'); return memory(); }, physicalFree: () => memory().freeBytes,
    engineFactory(id, options) {
      const device = options?.gpu ? 'gpu' : 'cpu';
      instances.push({ id, device });
      const state = { status: 'unloaded', queueDepth: 0, draining: false, offline: true, device, backend: options?.gpu?.backend ?? null, gpuLayers: options?.gpu ? 28 : 0 };
      states.set(id, state);
      let dead = false;
      let job;
      let gpuAllocated = false;
      async function initialize() {
        if (device === 'gpu' && !gpuAllocated) { gpuAllocated = true; gpuResidents++; peakGpuResidents = Math.max(peakGpuResidents, gpuResidents); }
        state.status = 'loading'; begin(`load:${id}`);
        job = delay(loadMs);
        await job;
        end(`load:${id}`);
        if (dead) throw new ChatError(503, 'chat_closed', 'Disposed.');
        if (id === 'quality' && failQuality) {
          state.status = 'error'; state.message = 'Quality failed.';
          if (terminationMs) {
            state.draining = true; begin(`terminate:${id}`);
            job = delay(terminationMs).then(() => { state.draining = false; end(`terminate:${id}`); });
          }
          throw new ChatError(503, 'chat_load_failed', 'Quality failed.');
        }
        state.status = 'ready';
      }
      function reply(messages, { signal, onTextChunk } = {}) {
        state.queueDepth = 1; begin(`reply:${id}`);
        return new Promise((resolve, reject) => {
          let ended = false;
          let timer;
          const finish = () => {
            if (ended) return;
            ended = true; clearTimeout(timer); state.queueDepth = 0; end(`reply:${id}`);
            signal?.removeEventListener('abort', abort);
          };
          const abort = () => {
            reject(new ChatError(499, 'chat_cancelled', 'Cancelled.'));
            clearTimeout(timer);
            job = delay(cancelMs).then(async () => {
              onTextChunk?.(' late cancelled text');
              finish();
              if (terminationMs) {
                state.draining = true; begin(`terminate:${id}`);
                await delay(terminationMs); state.draining = false; end(`terminate:${id}`);
              }
            });
          };
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => {
            onTextChunk?.('Hello'); onTextChunk?.(' there.');
            finish(); resolve({ text: 'Hello there.', profile: id, device });
          }, replyMs);
          job = new Promise(resolveJob => {
            const poll = () => ended ? resolveJob() : setTimeout(poll, 2);
            poll();
          });
        });
      }
      return {
        health: () => ({ ...state }), initialize, reply,
        summarize: async (messages, options) => { await reply(messages, options); return { summary: 'A remembered detail.' }; },
        async dispose() { dead = true; log.push(`dispose:${id}`); if (job) await job; state.status = 'unloaded'; if (gpuAllocated) { gpuResidents--; gpuAllocated = false; } log.push(`device-disposed:${id}:${device}`); },
      };
    },
  });
  return { engine, log, states, instances, peak: () => peak, running: () => running, peakGpuResidents: () => peakGpuResidents };
}

test('Hybrid routing handles simple turns, comparisons, personal recall, and dependent follow-ups', () => {
  const fast = ['Hi', 'Thanks', 'How are you?', 'Tell me a joke', 'Say the words "analyze this architecture"', 'What is the function of a leaf?'];
  const quality = ['Why did it fail?', 'Compare Redis and Postgres', 'Solve 3x + 7 = 22', 'What is my name?', 'Hi, can you compare the options?', "What's the difference between renting and buying?", 'Is Rust safer than C++?', 'Would you pick Redis or Postgres?', 'Which is better for a family, renting or buying?'];
  for (const content of fast) assert.equal(routeHybrid(user(content)).profile, 'fast', content);
  for (const content of quality) assert.equal(routeHybrid(user(content)).profile, 'quality', content);
  const history = [...user('Compare Redis and Postgres for persistent data.'), { role: 'assistant', content: 'They have different trade-offs.' }];
  for (const content of ['And the trade-offs?', 'What about option two?', 'Why?', 'Which is safer?']) assert.equal(routeHybrid([...history, ...user(content)]).profile, 'quality', content);
  for (const content of ['Thanks', 'Tell me a joke']) assert.equal(routeHybrid([...history, ...user(content)], { summary: 'The user is a developer.' }).profile, 'fast', content);
  assert.equal(routeHybrid(history, undefined, { operation: 'summary' }).profile, 'quality');
});

test('Accelerated Hybrid warms Fast on CPU and Quality on GPU without reloads between routes', async () => {
  const h = harness({ gpu: { backend: 'vulkan' } });
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    for (const [content, profile] of [['Hi', 'fast'], ['Compare two choices', 'quality'], ['Thanks', 'fast']]) {
      const result = await h.engine.reply(user(content), { profile: 'hybrid' });
      assert.equal(result.profile, profile); assert.equal(result.device, profile === 'fast' ? 'cpu' : 'gpu');
      const health = h.engine.health();
      assert.equal(health.profile, 'hybrid'); assert.equal(health.residency, 'dual');
      assert.equal(health.residentModels.fast.device, 'cpu'); assert.equal(health.residentModels.quality.device, 'gpu');
      assert.equal(health.residentModels.fast.loadCount, 1); assert.equal(health.residentModels.quality.loadCount, 1);
      assert.match(health.residencyReason, /CPU.*GPU/);
    }
    assert.deepEqual(h.instances, [{ id: 'fast', device: 'cpu' }, { id: 'quality', device: 'gpu' }]);
    assert.equal(h.log.some(line => line.startsWith('dispose:')), false);
    assert.equal(h.peak(), 1); assert.equal(h.peakGpuResidents(), 1);
  } finally { await h.engine.dispose(); }
});

test('Manual GPU profiles and mixed Hybrid replace incompatible runtimes without overlapping GPU contexts', async () => {
  const h = harness({ gpu: { backend: 'vulkan' } });
  try {
    await h.engine.initialize({ profile: 'fast' });
    assert.equal(h.engine.health().device, 'gpu');
    await h.engine.initialize({ profile: 'hybrid' });
    assert.deepEqual(h.instances, [{ id: 'fast', device: 'gpu' }, { id: 'fast', device: 'cpu' }, { id: 'quality', device: 'gpu' }]);
    await h.engine.initialize({ profile: 'fast' });
    assert.equal(h.engine.health().device, 'gpu');
    assert.equal(h.engine.health().residentModels.quality.status, 'unloaded');
    await h.engine.initialize({ profile: 'quality' });
    const qualityLoads = h.engine.health().residentModels.quality.loadCount;
    await h.engine.initialize({ profile: 'hybrid' });
    assert.equal(h.engine.health().residentModels.quality.loadCount, qualityLoads);
    assert.equal(h.engine.health().residentModels.fast.device, 'cpu');
    assert.equal(h.peakGpuResidents(), 1); assert.equal(h.peak(), 1);
  } finally { await h.engine.dispose(); }
});

test('Mixed Hybrid falls back to one resident when host RAM or commit cannot admit both', async () => {
  const h = harness({ gpu: { backend: 'vulkan' }, memory: () => budget(1) });
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    for (const [content, expected] of [['Compare two choices', 'gpu'], ['Thanks', 'cpu']]) {
      const reply = await h.engine.reply(user(content), { profile: 'hybrid' });
      assert.equal(reply.device, expected);
      assert.equal(h.engine.health().residency, 'single');
      assert.equal(Object.values(h.engine.health().residentModels).filter(state => state.status === 'ready').length, 1);
    }
    assert.equal(h.peakGpuResidents(), 1); assert.equal(h.peak(), 1);
  } finally { await h.engine.dispose(); }
});

test('A failed GPU eviction remains a barrier even after its client was removed from the pool', async () => {
  const created = [];
  const engine = createChatEngine({ gpu: { backend: 'vulkan' }, readMemory: async () => budget(1), engineFactory(id) {
    created.push(id);
    let status = 'unloaded';
    return {
      health: () => ({ status, queueDepth: 0 }),
      initialize: async () => { status = 'ready'; },
      reply: async () => ({ text: 'Hello.' }),
      dispose: async () => { throw new ChatError(503, 'gpu_stop_timeout', 'Exit was not confirmed.'); },
    };
  } });
  await engine.initialize({ profile: 'quality' });
  await assert.rejects(engine.reply(user('Hi'), { profile: 'hybrid' }), error => error.code === 'gpu_stop_timeout');
  await assert.rejects(engine.reply(user('Hi'), { profile: 'hybrid' }), error => error.code === 'gpu_stop_timeout');
  assert.deepEqual(created, ['quality']);
  await assert.rejects(engine.dispose(), error => error.code === 'gpu_stop_timeout');
});

test('Memory admission checks physical RAM, commit headroom, and reliable measurements', () => {
  assert.equal(canAdmitModels(budget(30), ['fast', 'quality']), true);
  assert.equal(canAdmitModels({ ...budget(30), commitFreeBytes: GiB }, ['fast']), false);
  assert.equal(canAdmitModels({ ...budget(30), reliable: false }, ['fast']), false);
  assert.equal(canAdmitModels(budget(1), []), false);
});

test('Both residents warm serially, routes precede text, and switching turns does not reload', async () => {
  const h = harness();
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    for (const [content, expected] of [['Hi', 'fast'], ['Compare two choices', 'quality'], ['Thanks', 'fast']]) {
      const events = [];
      const result = await h.engine.reply(user(content), { profile: 'hybrid', onRouting: event => events.push(event), onTextChunk: text => events.push(text) });
      assert.equal(events[0].profile, expected);
      assert.equal(events.slice(1).join(''), result.text);
      assert.equal(result.mode, 'hybrid'); assert.equal(result.profile, expected);
      assert.equal(h.engine.health().profile, 'hybrid');
    }
    const health = h.engine.health();
    assert.equal(health.status, 'ready'); assert.equal(health.residency, 'dual');
    assert.equal(health.residentModels.fast.loadCount, 1); assert.equal(health.residentModels.quality.loadCount, 1);
    assert.equal(h.peak(), 1);
  } finally { await h.engine.dispose(); }
});

test('Cancellation settles promptly but queued work waits for acknowledgement and worker draining', async () => {
  const h = harness({ replyMs: 120, cancelMs: 45, terminationMs: 35 });
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    const controller = new AbortController();
    const cancelledChunks = [];
    const pending = h.engine.reply(user('Compare two options'), { profile: 'hybrid', signal: controller.signal, onTextChunk: text => cancelledChunks.push(text) });
    const rejection = assert.rejects(pending, error => error.code === 'chat_cancelled');
    await until(() => h.log.includes('start:reply:quality'));
    const next = h.engine.reply(user('Thanks'), { profile: 'hybrid' });
    controller.abort(); await rejection;
    assert.equal(h.log.includes('start:reply:fast'), false);
    await next;
    assert.deepEqual(cancelledChunks, []);
    assert.ok(h.log.indexOf('end:terminate:quality') < h.log.indexOf('start:reply:fast'));
    assert.equal(h.peak(), 1);
  } finally { await h.engine.dispose(); }
});

test('Optional second warm-up preserves the healthy first model when RAM drops', async () => {
  let reads = 0;
  const h = harness({ memory: () => budget(++reads === 1 ? 30 : 1), failQuality: true });
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    assert.equal(h.engine.health().status, 'ready'); assert.equal(h.engine.health().residency, 'single');
    assert.equal(h.log.includes('dispose:fast'), false); assert.equal(h.log.includes('start:load:quality'), false);
  } finally { await h.engine.dispose(); }
});

test('Low-memory routing evicts, rereads memory, and uses the requested Quality model', async () => {
  const h = harness({ memory: () => budget(1) });
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    const result = await h.engine.reply(user('What is my name?'), { profile: 'hybrid' });
    assert.equal(result.profile, 'quality'); assert.equal(h.engine.health().residency, 'single');
    const eviction = h.log.indexOf('dispose:fast');
    const load = h.log.indexOf('start:load:quality');
    assert.ok(eviction >= 0 && load > eviction);
    assert.ok(h.log.slice(eviction + 1, load).includes('memory'));
    assert.equal(h.engine.health().residentModels.fast.status, 'unloaded');
  } finally { await h.engine.dispose(); }
});

test('Recovered memory permits both residents and updates residency metadata', async () => {
  let free = 1;
  const h = harness({ memory: () => budget(free) });
  try {
    await h.engine.initialize({ profile: 'hybrid' }); free = 30;
    await h.engine.reply(user('Compare two options'), { profile: 'hybrid' });
    assert.equal(h.engine.health().residency, 'dual');
    assert.equal(h.engine.health().residentModels.fast.loadCount, 1);
    assert.equal(h.engine.health().residentModels.quality.loadCount, 1);
  } finally { await h.engine.dispose(); }
});

test('A failed Quality model keeps Fast usable and drains before subsequent work', async () => {
  const h = harness({ failQuality: true, terminationMs: 35 });
  try {
    await h.engine.initialize({ profile: 'hybrid' });
    assert.equal(h.engine.health().status, 'ready'); assert.equal(h.engine.health().residency, 'single');
    const failed = h.engine.reply(user('Compare two options'), { profile: 'hybrid' });
    const rejected = assert.rejects(failed, error => error.code === 'chat_load_failed');
    const next = h.engine.reply(user('Hi'), { profile: 'hybrid' });
    await rejected;
    assert.equal((await next).profile, 'fast');
    assert.equal(h.engine.health().status, 'ready'); assert.equal(h.peak(), 1);
  } finally { await h.engine.dispose(); }
});

test('A resident worker error is visible and initialize retries the failed selected model', async () => {
  const h = harness();
  try {
    await h.engine.initialize({ profile: 'fast' });
    Object.assign(h.states.get('fast'), { status: 'error', message: 'Worker stopped.' });
    assert.equal(h.engine.health().status, 'error');
    await h.engine.initialize({ profile: 'fast' });
    assert.equal(h.engine.health().status, 'ready'); assert.equal(h.engine.health().residentModels.fast.loadCount, 2);
    await h.engine.initialize({ profile: 'hybrid' });
    await h.engine.reply(user('Compare options'), { profile: 'hybrid' });
    Object.assign(h.states.get('quality'), { status: 'error', message: 'Worker stopped.' });
    assert.equal(h.engine.health().status, 'error');
    await h.engine.initialize({ profile: 'hybrid' });
    assert.equal(h.engine.health().status, 'ready'); assert.equal(h.engine.health().residentModels.quality.loadCount, 2);
  } finally { await h.engine.dispose(); }
});

test('Dispose rejects pending initialization and queued turns without spawning another model', async () => {
  const h = harness({ loadMs: 50 });
  const loading = h.engine.initialize({ profile: 'hybrid' });
  const rejectedLoad = assert.rejects(loading, error => error.code === 'chat_closed');
  const queued = h.engine.reply(user('Hi'), { profile: 'hybrid' });
  const rejectedTurn = assert.rejects(queued, error => error.code === 'chat_closed');
  await until(() => h.log.includes('start:load:fast'));
  await h.engine.dispose(); await Promise.all([rejectedLoad, rejectedTurn]);
  assert.equal(h.running(), 0); assert.equal(h.log.includes('start:load:quality'), false);
});

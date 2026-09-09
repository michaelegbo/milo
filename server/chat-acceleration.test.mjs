import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcceleratedChatEngine } from './chat-acceleration.mjs';
import { ChatError } from './chat-config.mjs';

const supported = { available: true, backend: 'vulkan', deviceName: 'Test GPU', environment: { GGML_VK_VISIBLE_DEVICES: '0' } };
const user = [{ role: 'user', content: 'Hello Milo' }];
const closed = () => new ChatError(503, 'chat_closed', 'Disposed.');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(condition) {
  for (let count = 0; count < 150; count++) { if (condition()) return; await delay(3); }
  assert.fail('Fake engine did not reach the expected lifecycle state.');
}
function harness({ detect = async () => supported, gpuLoadMs = 8, failGpuLoad = false, failDispose = false } = {}) {
  const created = [];
  const log = [];
  const bridge = createAcceleratedChatEngine({
    detectGpu: detect,
    engineFactory(options) {
      const id = created.length;
      const device = options.gpu ? 'gpu' : 'cpu';
      let dead = false;
      let state = { status: 'unloaded', profile: 'fast', mode: 'fast', device: 'cpu', backend: null, gpuLayers: 0, queueDepth: 0, residentModels: {} };
      const tasks = new Set();
      function job(ms, finish) {
        const pending = deferred();
        const record = { pending, timer: setTimeout(() => {
          tasks.delete(record);
          try { pending.resolve(finish()); } catch (error) { pending.reject(error); }
        }, ms) };
        tasks.add(record);
        return pending.promise;
      }
      const engine = {
        options, id,
        health: () => ({ ...state }),
        initialize({ profile }) {
          state = { ...state, profile, mode: profile, status: 'loading' };
          log.push(`load:${device}:${id}`);
          return job(device === 'gpu' ? gpuLoadMs : 5, () => {
            if (dead) throw closed();
            if (device === 'gpu' && failGpuLoad) { state.status = 'error'; throw new ChatError(503, 'chat_load_failed', 'GPU allocation failed.'); }
            state = { ...state, status: 'ready', device, backend: options.gpu?.backend ?? null, gpuLayers: options.gpu ? 28 : 0 };
            log.push(`ready:${device}:${id}`);
          });
        },
        reply(messages, options = {}) {
          if (dead) return Promise.reject(closed());
          state.queueDepth += 1;
          return job(65, () => {
            state.queueDepth -= 1;
            options.onTextChunk?.('Hello.');
            return { text: 'Hello.', profile: options.profile, mode: options.profile, device, memory: options.memory };
          });
        },
        summarize(messages, options) { return this.reply(messages, options).then(() => ({ summary: 'Remembered.' })); },
        fail() { state.status = 'error'; },
        async dispose() {
          dead = true;
          log.push(`dispose-start:${device}:${id}`);
          for (const task of tasks) { clearTimeout(task.timer); task.pending.reject(closed()); }
          tasks.clear(); state.queueDepth = 0;
          await delay(12);
          if (failDispose) throw new ChatError(503, 'gpu_stop_timeout', 'Could not verify process exit.');
          state.status = 'unloaded';
          log.push(`dispose-end:${device}:${id}`);
        },
      };
      created.push(engine);
      return engine;
    },
  });
  return { bridge, created, log };
}

test('Detection is app-local and does not eagerly load a model or enable GPU', async () => {
  const h = harness();
  try {
    assert.equal(h.bridge.health().acceleration.status, 'detecting');
    await until(() => h.bridge.health().acceleration.available);
    assert.equal(h.bridge.health().acceleration.enabled, false);
    assert.equal(h.bridge.health().acceleration.deviceName, 'Test GPU');
    assert.equal(h.created.length, 1); assert.deepEqual(h.log, []);
  } finally { await h.bridge.dispose(); }
});

test('Acceleration validates booleans and unsupported devices preserve usable CPU', async () => {
  const h = harness({ detect: async () => ({ available: false, backend: false, deviceName: null, message: 'No compatible GPU runtime.' }) });
  try {
    assert.throws(() => h.bridge.setAcceleration('true'), error => error.code === 'invalid_acceleration');
    await until(() => h.bridge.health().acceleration.status === 'unavailable');
    assert.throws(() => h.bridge.setAcceleration(true), error => error.code === 'gpu_unavailable');
    await h.bridge.initialize({ profile: 'fast' });
    assert.equal((await h.bridge.reply(user)).device, 'cpu');
    await h.bridge.setAcceleration(false);
    assert.equal(h.created.length, 1);
  } finally { await h.bridge.dispose(); }
});

test('GPU on and off preserve Hybrid, report actual devices, and await exit before replacement', async () => {
  const h = harness();
  try {
    await h.bridge.initialize({ profile: 'hybrid' });
    const enabling = h.bridge.setAcceleration(true);
    assert.equal(h.bridge.health().acceleration.enabled, true);
    assert.equal(h.bridge.health().acceleration.status, 'switching');
    assert.equal(h.bridge.health().device, null);
    assert.throws(() => h.bridge.reply(user), error => error.code === 'acceleration_switching');
    assert.throws(() => h.bridge.initialize({ profile: 'quality' }), error => error.code === 'acceleration_switching');
    await enabling;
    assert.equal(h.bridge.health().profile, 'hybrid');
    assert.equal(h.bridge.health().device, 'gpu');
    assert.equal(h.bridge.health().gpuLayers, 28);
    assert.deepEqual(h.created[1].options.gpu.environment, { GGML_VK_VISIBLE_DEVICES: '0' });
    await h.bridge.setAcceleration(false);
    assert.equal(h.bridge.health().profile, 'hybrid');
    assert.equal(h.bridge.health().device, 'cpu');
    assert.equal(h.bridge.health().gpuLayers, 0);
    assert.equal(h.bridge.health().acceleration.revision, 2);
    assert.ok(h.log.indexOf('dispose-end:cpu:0') < h.log.indexOf('load:gpu:1'));
    assert.ok(h.log.indexOf('dispose-end:gpu:1') < h.log.indexOf('load:cpu:2'));
  } finally { await h.bridge.dispose(); }
});

test('OFF escapes an unfinished detector and prepares CPU without waiting for it', async () => {
  const probe = deferred();
  const h = harness({ detect: () => probe.promise });
  try {
    const enabling = h.bridge.setAcceleration(true);
    await until(() => h.log.includes('dispose-end:cpu:0'));
    await delay(2);
    await h.bridge.setAcceleration(false);
    await enabling;
    assert.equal(h.bridge.health().device, 'cpu');
    assert.equal(h.bridge.health().acceleration.enabled, false);
    assert.ok(h.created.every(engine => !engine.options.gpu));
    probe.resolve(supported);
  } finally { probe.resolve(supported); await h.bridge.dispose(); }
});

test('Rejected profile selection cannot change the mode restored by a device switch', async () => {
  const h = harness();
  try {
    await h.bridge.initialize({ profile: 'fast' });
    h.created[0].initialize = () => Promise.reject(new ChatError(409, 'profile_busy', 'Busy.'));
    await assert.rejects(h.bridge.initialize({ profile: 'quality' }), error => error.code === 'profile_busy');
    await h.bridge.setAcceleration(true);
    assert.equal(h.bridge.health().profile, 'fast');
  } finally { await h.bridge.dispose(); }
});

test('OFF during GPU warm-up cancels the load and waits for that process to exit', async () => {
  const h = harness({ gpuLoadMs: 200 });
  try {
    const enabling = h.bridge.setAcceleration(true);
    await until(() => h.log.includes('load:gpu:1'));
    await h.bridge.setAcceleration(false); await enabling;
    assert.equal(h.bridge.health().device, 'cpu');
    assert.equal(h.log.includes('ready:gpu:1'), false);
    assert.ok(h.log.indexOf('dispose-end:gpu:1') < h.log.indexOf('load:cpu:2'));
  } finally { await h.bridge.dispose(); }
});

test('Rapid ON/OFF/ON requests serialize retirement and the latest request wins', async () => {
  const h = harness();
  try {
    const one = h.bridge.setAcceleration(true);
    const two = h.bridge.setAcceleration(false);
    const three = h.bridge.setAcceleration(true);
    await Promise.all([one, two, three]);
    assert.equal(h.bridge.health().device, 'gpu');
    assert.equal(h.bridge.health().acceleration.revision, 3);
    assert.equal(h.created.length, 2);
  } finally { await h.bridge.dispose(); }
});

test('Switching stops active reply and summary work without forwarding late text or changing memory', async () => {
  const h = harness();
  const memory = { summary: 'The user is Sam.', facts: ['name: Sam'] };
  const original = structuredClone(memory);
  try {
    await h.bridge.initialize({ profile: 'hybrid' });
    const chunks = [];
    const replying = h.bridge.reply(user, { profile: 'hybrid', memory, onTextChunk: text => chunks.push(text) });
    const summarizing = h.bridge.summarize(user, { profile: 'hybrid', memory });
    const rejected = [assert.rejects(replying, error => error.code === 'chat_closed'), assert.rejects(summarizing, error => error.code === 'chat_closed')];
    await h.bridge.setAcceleration(true); await Promise.all(rejected);
    assert.deepEqual(chunks, []); assert.deepEqual(memory, original);
    assert.deepEqual((await h.bridge.reply(user, { profile: 'hybrid', memory })).memory, original);
  } finally { await h.bridge.dispose(); }
});

test('A GPU allocation or warm-up failure visibly restores the same profile on CPU', async () => {
  const h = harness({ failGpuLoad: true });
  try {
    await h.bridge.initialize({ profile: 'quality' });
    await h.bridge.setAcceleration(true);
    const health = h.bridge.health();
    assert.equal(health.profile, 'quality'); assert.equal(health.device, 'cpu');
    assert.equal(health.acceleration.enabled, false); assert.equal(health.acceleration.status, 'ready');
    assert.match(health.acceleration.message, /could not start.*CPU/);
    assert.equal(health.acceleration.revision, 2);
    assert.ok(h.log.indexOf('dispose-end:gpu:1') < h.log.indexOf('load:cpu:2'));
  } finally { await h.bridge.dispose(); }
});

test('A later GPU route/model failure starts CPU recovery and keeps the failing turn explicit', async () => {
  const h = harness();
  try {
    await h.bridge.setAcceleration(true);
    h.created[1].reply = () => { h.created[1].fail(); return Promise.reject(new ChatError(503, 'chat_load_failed', 'GPU stopped.')); };
    await assert.rejects(h.bridge.reply(user), error => error.code === 'chat_load_failed');
    await until(() => !h.bridge.health().acceleration.enabled && h.bridge.health().status === 'ready');
    assert.equal(h.bridge.health().device, 'cpu');
    assert.match(h.bridge.health().acceleration.message, /retry your last message/);
  } finally { await h.bridge.dispose(); }
});

test('Dispose during GPU preparation cancels it and never creates a replacement', async () => {
  const h = harness({ gpuLoadMs: 200 });
  const enabling = h.bridge.setAcceleration(true);
  const rejected = assert.rejects(enabling, error => error.code === 'chat_closed');
  await until(() => h.log.includes('load:gpu:1'));
  await h.bridge.dispose(); await rejected;
  assert.equal(h.created.length, 2); assert.equal(h.log.includes('ready:gpu:1'), false);
  assert.throws(() => h.bridge.setAcceleration(false), error => error.code === 'chat_closed');
});

test('An unconfirmed process exit blocks new model allocation and exposes an actionable error', async () => {
  const h = harness({ failDispose: true });
  await assert.rejects(h.bridge.setAcceleration(true), error => error.code === 'gpu_stop_timeout');
  assert.equal(h.created.length, 1); assert.equal(h.bridge.health().acceleration.status, 'error');
  await assert.rejects(h.bridge.setAcceleration(false), error => error.code === 'gpu_stop_timeout');
  assert.equal(h.created.length, 1);
  await assert.rejects(h.bridge.dispose(), error => error.code === 'gpu_stop_timeout');
});

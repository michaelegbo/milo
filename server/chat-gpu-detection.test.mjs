import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { detectChatGpu, gpuDeviceEnvironment, selectChatGpuCandidate, runChatGpuProbe } from './chat-gpu-detection.mjs';

test('an unresponsive native detector has a bounded stop and cannot hold Milo open', async () => {
  const child = new EventEmitter();
  let signal;
  let disconnected = false;
  let unreferenced = false;
  Object.assign(child, {
    pid: 123, connected: true, send() {},
    kill(value) { signal = value; return false; },
    disconnect() { disconnected = true; child.connected = false; },
    unref() { unreferenced = true; },
  });
  await assert.rejects(runChatGpuProbe({ type: 'supported' }, { timeoutMs: 5, stopTimeoutMs: 5, forkProcess: () => child }), /Restart Milo/);
  assert.equal(signal, 'SIGKILL');
  assert.equal(disconnected, true);
  assert.equal(unreferenced, true);
  assert.equal(child.listenerCount('exit'), 0);
  child.emit('error', new Error('late driver error'));
});

test('GPU selection prefers dedicated memory and selects each adapter in a new process environment', async () => {
  const calls = [];
  const result = await detectChatGpu({ probe: async (request, options) => {
    calls.push({ request, options });
    if (request.type === 'supported') return { supported: ['vulkan', false] };
    const index = options.environment.GGML_VK_VISIBLE_DEVICES;
    if (index === undefined) return { backend: 'vulkan', devices: ['Discrete', 'Integrated'] };
    return { backend: 'vulkan', devices: [index === '0' ? 'Discrete' : 'Integrated'], vram: { total: index === '0' ? 24 : 64, free: index === '0' ? 18 : 60, used: 6, unifiedSize: index === '0' ? 0 : 64 } };
  } });
  assert.equal(result.available, true);
  assert.equal(result.deviceName, 'Discrete');
  assert.deepEqual(result.environment, { GGML_VK_VISIBLE_DEVICES: '0' });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].options.environment.GGML_VK_VISIBLE_DEVICES, '1');
});

test('unavailable CUDA can fall back to an already-installed Vulkan backend', async () => {
  const result = await detectChatGpu({ probe: async (request) => {
    if (request.type === 'supported') return { supported: ['cuda', 'vulkan'] };
    if (request.backend === 'cuda') throw new Error('Missing CUDA runtime');
    return { backend: 'vulkan', devices: ['GPU'], vram: { total: 8, used: 1, free: 7, unifiedSize: 0 } };
  } });
  assert.equal(result.available, true);
  assert.equal(result.backend, 'vulkan');
});

test('missing backends, failed probes and ambiguous adapter isolation retain CPU availability', async () => {
  for (const probe of [
    async () => ({ supported: [false] }),
    async () => { throw new Error('Probe crashed'); },
    async (request) => request.type === 'supported' ? { supported: ['vulkan'] } : { backend: 'vulkan', devices: ['A', 'B'] },
  ]) {
    const result = await detectChatGpu({ probe });
    assert.equal(result.available, false);
    assert.equal(result.backend, false);
    assert.match(result.message, /CPU/);
  }
});

test('GPU admission ignores empty memory and ranks otherwise equal devices by current free memory', () => {
  assert.equal(selectChatGpuCandidate([{ deviceName: 'full', vram: { total: 24, free: 0 } }]), undefined);
  assert.equal(selectChatGpuCandidate([
    { deviceName: 'Busy', vram: { total: 24, free: 2, unifiedSize: 0 } },
    { deviceName: 'Free', vram: { total: 12, free: 10, unifiedSize: 0 } },
  ]).deviceName, 'Free');
  assert.deepEqual(gpuDeviceEnvironment('cuda', 1), { CUDA_VISIBLE_DEVICES: '1' });
  assert.deepEqual(gpuDeviceEnvironment('metal', 0), {});
});

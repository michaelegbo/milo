import { fork } from 'node:child_process';

const PROBE_URL = new URL('./chat-gpu-probe.mjs', import.meta.url);
const BACKENDS = ['cuda', 'vulkan', 'metal'];
const unavailable = (message = 'No compatible GPU runtime is available. Milo can keep using CPU.') => ({
  available: false, backend: false, deviceName: null, deviceIndex: null, environment: {}, vram: null, message,
});

export function gpuDeviceEnvironment(backend, index) {
  if (backend === 'vulkan') return { GGML_VK_VISIBLE_DEVICES: String(index) };
  if (backend === 'cuda') return { CUDA_VISIBLE_DEVICES: String(index) };
  return {};
}

export function runChatGpuProbe(request, { environment = {}, timeoutMs = 12000, stopTimeoutMs = 5000, forkProcess = fork } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Enumerate adapters independently of a previous application's selection.
    // Changes are confined to this child and never alter the host environment.
    delete env.GGML_VK_VISIBLE_DEVICES;
    delete env.CUDA_VISIBLE_DEVICES;
    Object.assign(env, environment);
    const child = forkProcess(PROBE_URL, [], { env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result;
    let failure;
    let settled = false;
    let stopTimer;
    const timer = setTimeout(() => stop(new Error('GPU detection timed out.')), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      child.removeAllListeners();
      // An unresponsive driver probe must not hold the server open forever.
      // Disconnect also triggers the child's own parent-loss exit handler.
      child.on('error', () => {});
      if (child.connected) { try { child.disconnect(); } catch {} }
      child.unref();
      if (error) reject(error);
      else resolve(result);
    };
    function stop(error) {
      if (settled) return;
      failure = error;
      child.kill('SIGKILL');
      stopTimer ??= setTimeout(() => finish(new Error('The GPU detector did not stop. Restart Milo before trying GPU again.')), stopTimeoutMs);
    }
    child.once('message', (message) => { result = message; });
    child.once('error', (error) => { if (!child.pid) finish(error); else stop(error); });
    child.once('exit', (code) => finish(failure ?? (code !== 0 || !result ? new Error('GPU detection could not finish.') : null)));
    child.send(request, (error) => { if (error) stop(error); });
  });
}

export function selectChatGpuCandidate(candidates) {
  return [...candidates].filter((candidate) => candidate.vram?.total > 0 && candidate.vram?.free > 0)
    .sort((a, b) => Number(a.vram.unifiedSize > 0) - Number(b.vram.unifiedSize > 0) || b.vram.free - a.vram.free)[0];
}

/** Detects only already-installed, app-local runtimes. Never loads a model. */
export async function detectChatGpu({ timeoutMs = 45000, probe = runChatGpuProbe } = {}) {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 45000));
  const inspect = (request, environment = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('GPU detection timed out.');
    return probe(request, { environment, timeoutMs: Math.min(12000, remaining) });
  };
  try {
    const result = await inspect({ type: 'supported' });
    const supported = BACKENDS.filter((backend) => result.supported?.includes(backend));
    for (const backend of supported) {
      let all;
      try { all = await inspect({ type: 'inspect', backend }); } catch { continue; }
      if (all.error || !Array.isArray(all.devices) || !all.devices.length) continue;
      const candidates = [];
      for (let index = 0; index < Math.min(all.devices.length, 8); index++) {
        const environment = gpuDeviceEnvironment(backend, index);
        let isolated;
        try { isolated = backend === 'metal' ? all : await inspect({ type: 'inspect', backend }, environment); } catch { continue; }
        if (isolated.error || isolated.devices?.length !== 1 || isolated.backend !== backend) continue;
        candidates.push({ available: true, backend, deviceName: isolated.devices[0], deviceIndex: index, environment, vram: isolated.vram });
      }
      const selected = selectChatGpuCandidate(candidates);
      if (selected) return { ...selected, message: `${selected.deviceName} is available for local conversation acceleration.` };
    }
    return unavailable();
  } catch {
    return unavailable('GPU detection could not finish. Milo can keep using CPU; restart Milo to detect again.');
  }
}

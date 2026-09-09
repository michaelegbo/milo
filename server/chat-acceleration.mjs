import { createChatEngine } from './chat-engine.mjs';
import { detectChatGpu } from './chat-gpu-detection.mjs';
import { ChatError, getChatMode } from './chat-config.mjs';

/** Runtime switch around the existing local model pool. Last requested device wins. */
export function createAcceleratedChatEngine({ engineFactory = options => createChatEngine(options), detectGpu = detectChatGpu } = {}) {
  let engine = engineFactory({});
  let lastHealth = engine.health();
  let mode = 'fast';
  let requested = false;
  let activeGpu = false;
  let revision = 0;
  let switching = false;
  let disposed = false;
  let transition;
  let bridgeError;
  let notice = '';
  let detection;
  let change = new AbortController();
  const retired = new WeakMap();
  const releases = new Set();
  const detectionPromise = Promise.resolve().then(() => detectGpu()).then(result => {
    detection = result;
    return result;
  }).catch(() => {
    detection = { available: false, backend: false, deviceName: null, message: 'GPU detection could not complete. Milo can still use CPU.' };
    return detection;
  });

  function health() {
    const current = engine?.health();
    if (current) lastHealth = current;
    const base = current ?? {
      ...lastHealth, profile: mode, mode, status: 'unloaded', device: null,
      backend: null, gpuLayers: 0, progress: null, queueDepth: 0, offline: false,
      residentModels: Object.fromEntries(Object.entries(lastHealth.residentModels ?? {}).map(([id, state]) => [id, { ...state, status: 'unloaded', device: null, backend: null, gpuLayers: 0, progress: null, queueDepth: 0, draining: false }])),
    };
    const acceleration = {
      available: Boolean(detection?.available), enabled: requested,
      status: switching ? 'switching' : bridgeError ? 'error' : !detection ? 'detecting' : detection.available ? 'ready' : 'unavailable',
      backend: detection?.backend || null, deviceName: detection?.deviceName ?? null,
      message: switching ? `Switching Milo to ${requested ? 'GPU' : 'CPU'}. The current reply stops while its model reloads.`
        : bridgeError?.message || notice || (!detection ? 'Checking for an app-compatible GPU. CPU remains available.'
          : requested ? base.profile === 'hybrid'
            ? `Hybrid keeps quick replies on CPU and uses ${detection.deviceName} for deeper replies. Voice and listening stay on CPU.`
            : `Accelerating replies on ${detection.deviceName} using ${detection.backend}. Voice and listening stay on CPU.`
            : detection.available ? `${detection.deviceName} is available. Replies currently use CPU.` : detection.message),
      revision,
    };
    return { ...base, ...(switching ? { profile: mode, mode, status: 'loading', message: acceleration.message } : {}), acceleration };
  }

  function retire(target) {
    if (!target) return;
    if (retired.has(target)) return retired.get(target);
    const release = Promise.resolve().then(() => target.dispose());
    retired.set(target, release);
    releases.add(release);
    // Observe rejection immediately, but keep the original rejecting promise in
    // the barrier. A failed exit must never permit another native model load.
    release.catch(() => {});
    return release;
  }
  function detach() {
    const target = engine;
    if (target) { lastHealth = target.health(); mode = lastHealth.profile ?? mode; }
    engine = undefined;
    retire(target);
  }
  async function drain() {
    while (releases.size) {
      const pending = [...releases];
      await Promise.all(pending);
      for (const release of pending) releases.delete(release);
    }
  }
  async function detectedOrChanged(signal) {
    let onAbort;
    const changed = new Promise(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([detectionPromise, changed]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  async function reconcile() {
    while (!disposed) {
      const operationRevision = revision;
      try {
        await drain();
        if (disposed) break;
        if (operationRevision !== revision) continue;
        const gpu = requested ? await detectedOrChanged(change.signal) : undefined;
        if (disposed) break;
        if (operationRevision !== revision) continue;
        if (requested && !gpu.available) {
          requested = false;
          revision += 1;
          notice = `${gpu.message} CPU has been restored.`;
          continue;
        }
        const target = engineFactory(gpu ? { gpu } : {});
        engine = target;
        await target.initialize({ profile: mode });
        if (disposed) break;
        if (operationRevision !== revision || engine !== target) continue;
        activeGpu = requested;
        switching = false;
        bridgeError = undefined;
        return health();
      } catch (error) {
        if (disposed) break;
        if (operationRevision !== revision) continue;
        if (requested && engine) {
          // A failed GPU load or warm-up returns to CPU, without claiming that
          // acceleration remains enabled or substituting another model profile.
          requested = false;
          revision += 1;
          notice = 'GPU acceleration could not start. Milo has returned to CPU; you can try GPU again.';
          detach();
          continue;
        }
        switching = false;
        bridgeError = error;
        throw error;
      }
    }
    throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
  }

  function setAcceleration(enabled) {
    if (typeof enabled !== 'boolean') throw new ChatError(400, 'invalid_acceleration', 'Set enabled to true or false.');
    if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
    if (enabled && detection && !detection.available) throw new ChatError(503, 'gpu_unavailable', detection.message);
    if (enabled === requested && (switching || enabled === activeGpu) && !bridgeError) return transition ?? Promise.resolve(health());
    requested = enabled;
    revision += 1;
    change.abort();
    change = new AbortController();
    switching = true;
    bridgeError = undefined;
    notice = '';
    detach();
    if (!transition) {
      transition = reconcile().finally(() => { transition = undefined; });
      transition.catch(() => {});
    }
    return transition;
  }

  function currentEngine(profile = mode) {
    getChatMode(profile);
    if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
    if (switching || !engine) throw new ChatError(409, 'acceleration_switching', 'Wait for Milo to finish switching devices before starting another reply.');
    return engine;
  }
  function initialize({ profile = 'fast' } = {}) {
    const target = currentEngine(profile);
    const pending = target.initialize({ profile });
    mode = target.health().profile ?? mode;
    bridgeError = undefined;
    return recoverGpuFailure(target, pending);
  }
  function operation(type, messages, options = {}) {
    const profile = options.profile ?? 'fast';
    const target = currentEngine(profile);
    const pending = target[type](messages, { ...options, profile });
    mode = target.health().profile ?? mode;
    return recoverGpuFailure(target, pending);
  }
  function recoverGpuFailure(target, pending) {
    return pending.catch(error => {
      if (!disposed && engine === target && requested && !switching && target.health().status === 'error') {
        void setAcceleration(false).catch(() => {});
        notice = 'The GPU model stopped. Milo has returned to CPU; please retry your last message.';
      }
      throw error;
    });
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    revision += 1;
    change.abort();
    detach();
    await drain();
    await transition?.catch(() => {});
  }
  return {
    health, initialize, setAcceleration,
    reply: (messages, options) => operation('reply', messages, options),
    summarize: (messages, options) => operation('summarize', messages, options),
    dispose,
  };
}

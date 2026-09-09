import { setTimeout as delay } from 'node:timers/promises';
import { freemem } from 'node:os';
import { createChatEngine as createSingleEngine } from './chat-single-engine.mjs';
import { CHAT_PROFILES, CHAT_MODES, ChatError, getChatMode, validateChatMessages, validateChatMemory } from './chat-config.mjs';
import { routeHybrid } from './chat-router.mjs';
import { readChatMemoryBudget, canAdmitModels, MEMORY_RESERVE } from './chat-memory-budget.mjs';
export { CHAT_MODEL_ID, CHAT_PROFILES, CHAT_MODES, ChatError, getChatProfile, getChatMode, validateChatMessages, validateChatMemory } from './chat-config.mjs';

const MODEL_IDS = ['fast', 'quality'];
const MAX_PENDING = 2;

/** Two optional resident models share one preparation/inference queue. */
export function createChatEngine({ gpu = undefined, engineFactory = (_id, options) => createSingleEngine(options), readMemory = readChatMemoryBudget, physicalFree = freemem } = {}) {
  const clients = new Map();
  const clientRuntimes = new Map();
  const evictions = new Set();
  const loadCounts = { fast: 0, quality: 0 };
  const queue = [];
  let active;
  let disposed = false;
  let mode = 'fast';
  let selectedModel = 'fast';
  let prepared = false;
  let preparing = false;
  let loadingTarget;
  let preparation;
  let preparationMode;
  let lastError;
  let residency = 'single';
  let residencyReason = 'Only the selected model is loaded.';

  function modelHealth(id) {
    return { device: 'cpu', status: 'unloaded', progress: null, message: 'Not loaded.', ...clients.get(id)?.health(), profile: id, model: CHAT_PROFILES[id].model, loadCount: loadCounts[id] };
  }
  const modelGpu = id => gpu && (mode !== 'hybrid' || id === 'quality') ? gpu : undefined;
  const runtimeKey = id => modelGpu(id)?.backend ?? 'cpu';
  const matchesRuntime = id => clientRuntimes.get(id) === runtimeKey(id);
  const dualReason = () => gpu ? 'Fast stays warm on CPU and Quality stays warm on GPU; one replies at a time.' : 'Both models stay warm; only one performs inference at a time.';
  function ready(id) { return clients.has(id) && matchesRuntime(id) && clients.get(id).health().status === 'ready'; }
  function requiredFailure() {
    const required = mode === 'hybrid' ? residency === 'dual' ? MODEL_IDS : [selectedModel] : [mode];
    return required.filter(Boolean).map(id => clients.get(id)?.health()).find(state => state?.status === 'error');
  }
  function preparedHealthy() {
    if (!prepared || requiredFailure()) return false;
    return mode === 'hybrid' ? residency === 'dual' ? MODEL_IDS.every(ready) : MODEL_IDS.some(ready) : ready(mode);
  }
  function getClient(id) {
    if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
    if (!clients.has(id)) {
      clients.set(id, engineFactory(id, { gpu: modelGpu(id) }));
      clientRuntimes.set(id, runtimeKey(id));
    }
    return clients.get(id);
  }
  async function evict(id) {
    const client = clients.get(id);
    if (!client) return;
    clients.delete(id);
    clientRuntimes.delete(id);
    const eviction = Promise.resolve().then(() => client.dispose());
    evictions.add(eviction);
    eviction.catch(() => {});
    await eviction;
    evictions.delete(eviction);
  }
  function health() {
    const residentModels = Object.fromEntries(MODEL_IDS.map(id => [id, modelHealth(id)]));
    const selected = selectedModel ? residentModels[selectedModel] : MODEL_IDS.map(id => residentModels[id]).find(state => state.status === 'ready');
    const loading = loadingTarget ? residentModels[loadingTarget] : undefined;
    const error = lastError ?? requiredFailure();
    const status = preparing || loadingTarget ? 'loading' : error ? 'error' : preparedHealthy() ? 'ready' : 'unloaded';
    const message = (preparing || loadingTarget ? undefined : error?.message) ?? (loading?.message || (preparing ? 'Preparing the local conversation models.' : preparedHealthy() ? mode === 'hybrid' ? `Hybrid is ready. ${residencyReason}` : `${CHAT_MODES[mode].label} is ready. Replies run locally on your ${selected?.device === 'gpu' ? 'GPU' : 'CPU'}.` : 'Start a conversation to load the local reply model.'));
    return {
      status, profile: mode, mode, selectedModel, model: selected?.model ?? CHAT_MODES[mode].model,
      device: selected?.device ?? 'cpu', backend: selected?.backend ?? null, gpuLayers: selected?.gpuLayers ?? 0, dtype: 'q4_k_m', progress: loading?.progress ?? (prepared ? 100 : null), message,
      offline: MODEL_IDS.filter(id => clients.has(id)).every(id => residentModels[id].offline === true) && prepared,
      queueDepth: queue.filter(task => task.type !== 'prepare').length + Number(Boolean(active && active.type !== 'prepare')),
      residency, residencyReason, residentModels,
      profiles: Object.values(CHAT_MODES).map(({ id, label, model, bytes, license, automatic }) => ({ id, label, model, downloadBytes: bytes, license, ...(automatic ? { automatic: true } : {}) })),
    };
  }
  async function load(id) {
    if (clients.has(id) && !matchesRuntime(id)) await evict(id);
    if (modelGpu(id)) {
      // Manual Fast uses GPU; Hybrid reserves the sole native GPU context for
      // Quality and keeps Fast on CPU. Never overlap different GPU residents.
      for (const other of MODEL_IDS) if (other !== id && clients.has(other) && clientRuntimes.get(other) !== 'cpu') await evict(other);
    }
    await Promise.all(evictions);
    loadingTarget = id;
    loadCounts[id] += 1;
    const client = getClient(id);
    try { await client.initialize({ profile: id }); }
    finally { await waitUntilIdle(client); loadingTarget = undefined; }
    if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
  }
  async function ensureTarget(id) {
    const other = id === 'fast' ? 'quality' : 'fast';
    if (mode !== 'hybrid') {
      await evict(other);
      residency = 'single';
      residencyReason = 'Only the selected model is loaded.';
    } else if (clients.has(other)) {
      const memory = !ready(id) || physicalFree() < MEMORY_RESERVE ? await readMemory({ refresh: true }) : undefined;
      if (memory && !canAdmitModels(memory, ready(id) ? [] : [id])) {
        await evict(other);
        // Await disposal and read current physical/commit headroom again. Native
        // memory checks remain enabled when the requested model is loaded.
        await readMemory({ refresh: true });
        residency = 'single';
        residencyReason = 'RAM is limited, so Hybrid loads one model at a time. Routing stays the same.';
      }
    }
    if (!ready(id)) await load(id);
    if (mode === 'hybrid' && ready('fast') && ready('quality')) {
      residency = 'dual';
      residencyReason = dualReason();
    }
  }
  async function prepareMode(requestedMode, initialTarget) {
    const changed = mode !== requestedMode;
    mode = requestedMode;
    if (changed) { prepared = false; selectedModel = requestedMode === 'hybrid' ? initialTarget ?? null : requestedMode; }
    lastError = undefined;
    if (preparedHealthy()) return;
    prepared = false;
    preparing = true;
    try {
      for (const id of MODEL_IDS) if (clients.has(id) && !matchesRuntime(id)) await evict(id);
      if (mode !== 'hybrid') {
        selectedModel = mode;
        await ensureTarget(mode);
      } else {
        const missing = MODEL_IDS.filter(id => !ready(id));
        const memory = await readMemory({ refresh: true });
        const dual = canAdmitModels(memory, missing);
        residency = dual ? 'dual' : 'single';
        residencyReason = dual ? dualReason() : 'Available RAM or commit headroom is limited. Hybrid loads the selected model when needed.';
        const first = initialTarget ?? (selectedModel && clients.get(selectedModel)?.health().status === 'error' ? selectedModel : MODEL_IDS.find(id => ready(id))) ?? 'fast';
        await ensureTarget(first);
        if (dual) {
          const other = first === 'fast' ? 'quality' : 'fast';
          try {
            const admission = await readMemory({ refresh: true });
            if (ready(other) || canAdmitModels(admission, [other])) {
              if (!ready(other)) await load(other);
            } else {
              residency = 'single';
              residencyReason = 'Available RAM changed during preparation. Hybrid keeps one model warm and routes each turn normally.';
            }
          } catch (error) {
            // Extra-model preparation may fail without destroying the healthy
            // model. A later route to the failed model still retries or errors;
            // it never silently substitutes Fast for a Quality request.
            await evict(other);
            if (!ready(first)) throw error;
            residency = 'single';
            residencyReason = `${CHAT_PROFILES[other].label} could not stay loaded. Hybrid will retry it when a turn needs it.`;
          }
          if (!(ready('fast') && ready('quality'))) residency = 'single';
        }
      }
      prepared = true;
    } catch (error) {
      lastError = error;
      throw error;
    } finally { preparing = false; }
  }
  function settle(task, error, result) {
    if (task.settled) return;
    task.settled = true;
    task.signal?.removeEventListener('abort', task.onAbort);
    if (error) task.reject(error);
    else task.resolve(result);
  }
  async function waitUntilIdle(client) {
    // A child rejects a cancelled caller immediately but retains its native CPU
    // slot until acknowledgement or its bounded worker-reset timeout.
    while (!disposed && (client.health().queueDepth > 0 || client.health().draining)) await delay(25);
  }
  async function processQueue() {
    if (active || !queue.length || disposed) return;
    const task = queue.shift();
    active = task;
    let client;
    let completedResult;
    let failure;
    if (task.type === 'prepare') {
      mode = task.mode;
      prepared = false;
      preparing = true;
      lastError = undefined;
    }
    try {
      // The HTTP route can write headers before callbacks, including routing.
      await Promise.resolve();
      if (task.settled || disposed) return;
      if (task.type === 'prepare') {
        await prepareMode(task.mode);
        completedResult = health();
        return;
      }
      if (task.mode === 'hybrid') task.onRouting?.({ profile: task.target, reason: task.routing.reason, rule: task.routing.rule });
      await prepareMode(task.mode, task.target);
      selectedModel = task.target;
      if (task.settled || disposed) return;
      await ensureTarget(task.target);
      if (task.settled || disposed) return;
      client = getClient(task.target);
      const options = {
        profile: task.target, signal: task.controller.signal, memory: task.memory,
        onTextChunk(text) { if (!task.settled) task.onTextChunk?.(text); },
      };
      const result = await (task.type === 'summary' ? client.summarize(task.messages, options) : client.reply(task.messages, options));
      completedResult = { ...result, mode: task.mode, profile: task.target, ...(task.routing ? { routingReason: task.routing.reason, routingRule: task.routing.rule } : {}) };
    } catch (error) {
      failure = error;
      if (task.target && !ready(task.target) && !task.settled && !disposed) lastError = error;
    } finally {
      if (client) await waitUntilIdle(client);
      if (active === task) active = undefined;
      if (failure) settle(task, failure);
      else if (completedResult !== undefined) settle(task, undefined, completedResult);
      void processQueue();
    }
  }
  function enqueue(type, messages, { signal, profile = 'fast', memory, onTextChunk, onRouting } = {}) {
    const validated = validateChatMessages(messages, { requireLatestUser: type !== 'summary' });
    const validatedMemory = validateChatMemory(memory);
    getChatMode(profile);
    for (const callback of [onTextChunk, onRouting]) if (callback != null && typeof callback !== 'function') throw new ChatError(400, 'invalid_stream', 'Stream callbacks must be functions.');
    if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
    if (signal?.aborted) return Promise.reject(new ChatError(499, 'chat_cancelled', 'Conversation turn cancelled.'));
    if (preparation && preparationMode !== profile) throw new ChatError(409, 'profile_loading', 'Wait for the current mode to load before changing profiles.');
    if (queue.length + Number(Boolean(active)) >= MAX_PENDING) throw new ChatError(429, 'chat_busy', 'Milo is already thinking. Wait a moment and try again.');
    const routing = profile === 'hybrid' ? routeHybrid(validated, validatedMemory, { operation: type }) : undefined;
    const task = { type, mode: profile, target: routing?.profile ?? profile, routing, messages: validated, memory: validatedMemory, onTextChunk, onRouting, signal, controller: new AbortController(), settled: false };
    const promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.onAbort = () => {
      task.controller.abort();
      settle(task, new ChatError(499, 'chat_cancelled', 'Conversation turn cancelled.'));
      const index = queue.indexOf(task);
      if (index !== -1) queue.splice(index, 1);
    };
    signal?.addEventListener('abort', task.onAbort, { once: true });
    queue.push(task);
    void processQueue();
    return promise;
  }
  function initialize({ profile = 'fast' } = {}) {
    getChatMode(profile);
    if (disposed) return Promise.reject(new ChatError(503, 'chat_closed', 'The conversation engine has stopped.'));
    if (preparation) return preparationMode === profile ? preparation : Promise.reject(new ChatError(409, 'profile_loading', 'Wait for the current mode to load before changing profiles.'));
    if (preparedHealthy() && mode === profile && !lastError) return Promise.resolve();
    if (active || queue.length) return Promise.reject(new ChatError(409, 'profile_busy', 'Finish or stop the current turn before changing profiles.'));
    const task = { type: 'prepare', mode: profile, settled: false };
    const promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    preparationMode = profile;
    preparation = promise.finally(() => { preparation = undefined; preparationMode = undefined; });
    queue.push(task);
    void processQueue();
    return preparation;
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    const error = new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
    active?.controller?.abort();
    if (active) settle(active, error);
    for (const task of queue.splice(0)) settle(task, error);
    await Promise.all([...MODEL_IDS.map(id => evict(id)), ...evictions]);
    if (preparation) await preparation.catch(() => {});
  }
  return { initialize, health, reply: (messages, options) => enqueue('reply', messages, options), summarize: (messages, options) => enqueue('summary', messages, options), dispose };
}

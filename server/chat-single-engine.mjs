import { createChatWorkerTransport } from './chat-worker-transport.mjs';
import { CHAT_PROFILES, ChatError, getChatProfile, validateChatMessages, validateChatMemory } from './chat-config.mjs';
export { CHAT_MODEL_ID, CHAT_PROFILES, ChatError, getChatProfile, validateChatMessages, validateChatMemory } from './chat-config.mjs';

const MAX_PENDING = 2;
const INITIALIZE_TIMEOUT_MS = 15 * 60 * 1000;

/** One resident local model, one inference, and at most one waiting operation. */
export function createChatEngine({ gpu, workerFactory = createChatWorkerTransport } = {}) {
  let worker;
  let initialization;
  let loadResolve;
  let loadReject;
  let initializationTimer;
  let active;
  let nextId = 0;
  let disposed = false;
  let draining = Promise.resolve();
  let drainingCount = 0;
  const queue = [];
  let state = { status: 'unloaded', profile: 'fast', model: CHAT_PROFILES.fast.model, device: 'cpu', dtype: 'q4_k_m', progress: null, message: 'Start a conversation to load Milo’s local reply model.', offline: false };

  function health() {
    return { ...state, queueDepth: queue.length + Number(Boolean(active)), draining: drainingCount > 0, profiles: Object.values(CHAT_PROFILES).map(({ id, label, model, bytes, license }) => ({ id, label, model, downloadBytes: bytes, license })) };
  }
  function trackTermination(promise) {
    drainingCount += 1;
    const tracked = Promise.resolve(promise).finally(() => { drainingCount -= 1; });
    draining = Promise.all([draining, tracked]).then(() => {});
    draining.catch(() => {});
    return tracked;
  }
  function finish(task, error, result) {
    if (!task || task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    task.signal?.removeEventListener('abort', task.onAbort);
    if (error) task.reject(error);
    else task.resolve(result);
  }
  function failWorker(error) {
    const failedWorker = worker;
    worker = undefined;
    clearTimeout(initializationTimer);
    clearTimeout(active?.killTimer);
    state = { ...state, status: 'error', progress: null, message: error.message };
    loadReject?.(error);
    loadResolve = loadReject = undefined;
    finish(active, error);
    active = undefined;
    for (const task of queue.splice(0)) finish(task, error);
    if (failedWorker) void trackTermination(failedWorker.terminate()).catch(() => {});
  }
  function cancel(task, error) {
    if (task.settled) return;
    finish(task, error);
    const index = queue.indexOf(task);
    if (index !== -1) queue.splice(index, 1);
    if (active === task && task.started) {
      worker?.postMessage({ type: 'cancel', id: task.id });
      task.killTimer = setTimeout(() => {
        if (active === task) failWorker(new ChatError(503, 'chat_restarting', 'The conversation engine is resetting. Start the conversation again.'));
      }, 20000);
    }
  }

  function ensureProfile(profileId, forActiveTask = false) {
    const profile = getChatProfile(profileId);
    if (disposed) return Promise.reject(new ChatError(503, 'chat_closed', 'The conversation engine has stopped. Restart the server.'));
    if (initialization) {
      if (state.profile === profile.id) return initialization;
      return Promise.reject(new ChatError(409, 'profile_loading', 'Wait for the current model to load before changing profiles.'));
    }
    if (state.profile === profile.id && state.status === 'ready') return Promise.resolve();
    if (!forActiveTask && (active || queue.length)) return Promise.reject(new ChatError(409, 'profile_busy', 'Finish or stop the current turn before changing profiles.'));
    state = { ...state, status: 'loading', profile: profile.id, model: profile.model, progress: 0, offline: false, message: `Preparing ${profile.label}. First launch downloads ${(profile.bytes / 1e9).toFixed(2)} GB.` };
    const previousWorker = worker;
    worker = undefined;
    const operation = (async () => {
      // Await termination before creating the replacement so two model contexts
      // cannot compete for memory or process a turn under the wrong profile.
      if (previousWorker) await trackTermination(previousWorker.terminate());
      await draining;
      if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
      await new Promise((resolve, reject) => {
        loadResolve = resolve;
        loadReject = reject;
        worker = workerFactory({ profile: profile.id, gpu });
        const thisWorker = worker;
        initializationTimer = setTimeout(() => {
          if (worker === thisWorker) failWorker(new ChatError(503, 'chat_load_timeout', 'Loading the conversation model timed out. Check your connection and try again.'));
        }, INITIALIZE_TIMEOUT_MS);
        worker.on('message', (event) => {
          if (worker !== thisWorker) return;
          if (event.type === 'health') {
            state = { ...state, ...event.health };
            if (state.status === 'ready') {
              clearTimeout(initializationTimer);
              loadResolve?.();
              loadResolve = loadReject = undefined;
            } else if (state.status === 'error') failWorker(new ChatError(503, 'chat_load_failed', state.message));
            return;
          }
          if (active?.id !== event.id) return;
          if (event.type === 'chunk') {
            if (!active.settled && typeof event.text === 'string') {
              try { active.onTextChunk?.(event.text); }
              catch { cancel(active, new ChatError(499, 'chat_cancelled', 'The conversation stream was closed.')); }
            }
          } else if (event.type === 'result' || event.type === 'error') {
            clearTimeout(active.killTimer);
            const error = event.type === 'error' ? new ChatError(event.status ?? 500, event.code ?? 'chat_failed', event.message ?? 'Milo could not reply. Try again.') : undefined;
            finish(active, error, event.result);
            active = undefined;
            void processQueue();
          }
        });
        worker.on('error', () => {
          if (worker === thisWorker) failWorker(new ChatError(503, 'chat_worker_error', 'The local conversation engine stopped unexpectedly. Start the conversation again.'));
        });
        worker.on('exit', (code) => {
          if (worker === thisWorker && !disposed) failWorker(new ChatError(503, 'chat_worker_exit', `The conversation engine exited (${code}). Start the conversation again.`));
        });
        worker.postMessage({ type: 'initialize' });
      });
    })();
    initialization = operation.finally(() => { initialization = undefined; });
    return initialization;
  }
  function initialize({ profile = 'fast' } = {}) { return ensureProfile(profile); }

  async function processQueue() {
    if (active || !queue.length || disposed) return;
    const task = queue.shift();
    active = task;
    try {
      await ensureProfile(task.profile, true);
      if (task.settled) {
        if (active === task) active = undefined;
        void processQueue();
        return;
      }
      task.started = true;
      task.timer = setTimeout(() => cancel(task, new ChatError(504, 'chat_timeout', 'Milo took too long. Try a shorter question.')), task.type === 'summary' ? 120000 : 90000);
      worker.postMessage({ type: task.type, id: task.id, messages: task.messages, memory: task.memory });
    } catch (error) {
      finish(task, error);
      if (active === task) active = undefined;
      void processQueue();
    }
  }
  function enqueue(type, messages, { signal, profile = 'fast', memory, onTextChunk } = {}) {
    const validated = validateChatMessages(messages, { requireLatestUser: type !== 'summary' });
    const validatedMemory = validateChatMemory(memory);
    getChatProfile(profile);
    if (onTextChunk != null && typeof onTextChunk !== 'function') throw new ChatError(400, 'invalid_stream', 'The text callback must be a function.');
    if (disposed) throw new ChatError(503, 'chat_closed', 'The conversation engine has stopped. Restart the server.');
    if (signal?.aborted) return Promise.reject(new ChatError(499, 'chat_cancelled', 'Conversation turn cancelled.'));
    if (initialization && state.profile !== profile) throw new ChatError(409, 'profile_loading', 'Wait for the current model to load before changing profiles.');
    if (queue.length + Number(Boolean(active)) >= MAX_PENDING) throw new ChatError(429, 'chat_busy', 'Milo is already thinking. Wait a moment and try again.');
    const task = { id: ++nextId, type, profile, memory: validatedMemory, messages: validated, signal, onTextChunk, settled: false, started: false };
    const promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.onAbort = () => cancel(task, new ChatError(499, 'chat_cancelled', 'Conversation turn cancelled.'));
    signal?.addEventListener('abort', task.onAbort, { once: true });
    queue.push(task);
    void processQueue();
    return promise;
  }
  function reply(messages, options) { return enqueue('reply', messages, options); }
  function summarize(messages, options) { return enqueue('summary', messages, options); }
  async function dispose() {
    disposed = true;
    clearTimeout(initializationTimer);
    const stopped = new ChatError(503, 'chat_closed', 'The conversation engine has stopped.');
    loadReject?.(stopped);
    finish(active, stopped);
    clearTimeout(active?.killTimer);
    for (const task of queue.splice(0)) finish(task, stopped);
    active = undefined;
    const stopping = worker;
    worker = undefined;
    if (stopping) await trackTermination(stopping.terminate());
    await draining;
    if (initialization) await initialization.catch(() => {});
  }
  return { health, initialize, reply, summarize, dispose };
}

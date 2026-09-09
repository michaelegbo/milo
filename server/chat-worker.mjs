import { parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CHAT_SYSTEM_PROMPT, CHAT_SUMMARY_PROMPT, CHAT_MAX_SUMMARY_LENGTH, ChatError, getChatProfile, chatSystemPrompt, validateChatMessages, validateChatMemory } from './chat-config.mjs';
import { resolveChatModel } from './chat-model-cache.mjs';
import { createReplyStream } from './chat-reply-stream.mjs';

const profile = getChatProfile(workerData?.profile ?? process.argv[2] ?? 'fast');
const gpuBackend = parentPort ? undefined : process.argv[3];
const channel = parentPort ?? {
  postMessage(event) { if (process.connected) process.send(event); },
  on(event, callback) { process.on(event, callback); },
};
if (!parentPort) process.on('disconnect', () => process.exit(0));
let session;
let actualDevice = { device: 'cpu', backend: null, gpuLayers: 0 };
let initialization;
let active;
const update = (health) => channel.postMessage({ type: 'health', health: { ...health, ...actualDevice, processId: gpuBackend ? process.pid : null, profile: profile.id, model: profile.model } });

function initialize() {
  if (initialization) return initialization;
  initialization = (async () => {
    const modelPath = await resolveChatModel(profile, update);
    update({ status: 'loading', progress: 96, message: `Loading the ${profile.label} conversation model on ${gpuBackend ? 'GPU' : 'CPU'}.` });
    const library = await import('node-llama-cpp');
    const threads = Math.max(1, Math.min(6, availableParallelism() - 1));
    const llama = await library.getLlama({ gpu: gpuBackend || false, maxThreads: threads, logLevel: 'error', build: 'never', skipDownload: true });
    if (gpuBackend ? llama.gpu !== gpuBackend : llama.gpu !== false) throw new Error('The conversation engine loaded a different device than requested.');
    const model = await llama.loadModel({ modelPath, gpuLayers: gpuBackend ? { min: 1, fitContext: { contextSize: 6144 } } : 0, useMmap: true });
    if (gpuBackend && model.gpuLayers < 1) throw new Error('The model could not offload any layers to the GPU.');
    actualDevice = { device: gpuBackend ? 'gpu' : 'cpu', backend: gpuBackend || null, gpuLayers: model.gpuLayers };
    const context = await model.createContext({ contextSize: 6144, sequences: 1, threads, batchSize: 256 });
    const chatWrapper = profile.id === 'quality' ? new library.QwenChatWrapper({ thoughts: 'discourage' }) : 'auto';
    update({ status: 'loading', progress: 99, message: `Warming up ${profile.label} conversation.` });
    session = new library.LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: CHAT_SYSTEM_PROMPT, chatWrapper });
    try {
      const warmup = await session.prompt('Say hello briefly.', { maxTokens: 12, temperature: 0, budgets: { thoughtTokens: 0 }, signal: AbortSignal.timeout(60000) });
      if (!warmup.trim()) throw new Error('Conversation warm-up returned no text.');
    } finally { session.resetChatHistory(); }
    update({ status: 'ready', progress: 100, offline: true, message: `${profile.label} is ready. Replies run locally on your ${gpuBackend ? 'GPU' : 'CPU'}.`, cpuThreads: threads });
  })();
  return initialization;
}

async function generate(type, id, messages, memory) {
  if (active) throw new ChatError(429, 'chat_busy', 'The conversation engine is already replying.');
  const controller = new AbortController();
  active = { id, controller };
  const started = performance.now();
  let firstChunkMs = null;
  let stoppedAtLimit = false;
  try {
    await initialize();
    const validated = validateChatMessages(messages, { requireLatestUser: type !== 'summary' });
    const validatedMemory = validateChatMemory(memory);
    const summary = type === 'summary';
    const systemPrompt = summary ? CHAT_SUMMARY_PROMPT : chatSystemPrompt(validatedMemory);
    session.setChatHistory([
      { type: 'system', text: systemPrompt },
      ...(summary ? [] : validated.slice(0, -1).map((message) => message.role === 'user' ? { type: 'user', text: message.content } : { type: 'model', response: [message.content] })),
    ]);
    const prompt = summary ? `Conversation data to summarize:\n${JSON.stringify({ previousMemory: validatedMemory, messages: validated })}` : validated.at(-1).content;
    const stream = summary ? undefined : createReplyStream((text) => {
      if (firstChunkMs == null) firstChunkMs = Math.round(performance.now() - started);
      channel.postMessage({ type: 'chunk', id, text });
    }, () => {
      stoppedAtLimit = true;
      controller.abort(new Error('Reply reached its spoken length limit.'));
    });
    const response = await session.prompt(prompt, {
      maxTokens: summary ? 280 : profile.maxTokens,
      temperature: 0,
      repeatPenalty: { lastTokens: 64, penalty: 1.05 },
      budgets: { thoughtTokens: 0 },
      signal: controller.signal,
      stopOnAbortSignal: true,
      onTextChunk: summary ? undefined : (chunk) => stream.push(chunk),
    });
    if (controller.signal.aborted && !stoppedAtLimit) controller.signal.throwIfAborted();
    const metadata = { generationMs: Math.round(performance.now() - started), model: profile.model, ...actualDevice, profile: profile.id };
    if (summary) {
      const text = response.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
      const clipped = text.slice(0, CHAT_MAX_SUMMARY_LENGTH);
      const result = clipped.length < text.length ? clipped.slice(0, Math.max(1, clipped.lastIndexOf(' '))) : clipped;
      if (!result) throw new ChatError(500, 'empty_summary', 'Milo could not summarize this conversation. Please try again.');
      channel.postMessage({ type: 'result', id, result: { summary: result, ...metadata } });
    } else {
      const text = stream.finish();
      channel.postMessage({ type: 'result', id, result: { ...metadata, generationMs: Math.round(performance.now() - started), text, firstChunkMs } });
    }
  } finally {
    session?.resetChatHistory();
    active = undefined;
  }
}

channel.on('message', (event) => {
  if (event.type === 'cancel') {
    if (active?.id === event.id) active.controller.abort(new ChatError(499, 'chat_cancelled', 'Conversation turn cancelled.'));
    return;
  }
  if (event.type === 'initialize') {
    initialize().catch((error) => update({ status: 'error', progress: null, message: error.message || 'The conversation model could not load. Check your connection and try again.' }));
    return;
  }
  if (event.type === 'reply' || event.type === 'summary') {
    generate(event.type, event.id, event.messages, event.memory).catch((error) => channel.postMessage({ type: 'error', id: event.id, status: error.status ?? 500, code: error.code ?? 'chat_failed', message: error instanceof ChatError ? error.message : 'Milo could not complete that reply. Try again.' }));
  }
});

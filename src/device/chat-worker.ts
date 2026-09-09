import { Wllama, LogLevel } from '@wllama/wllama/esm/index.js';
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import compatWasmUrl from '@wllama/wllama-compat/wasm/wllama.wasm?url';
import compatWorkerCode from '@wllama/wllama-compat/wasm/wllama.js?raw';
import { DEVICE_CHAT_MODELS } from './chat-models';
import { CHAT_PROMPT, SUMMARY_PROMPT, chatInputs, routeDeviceChat, type ChatMode, type ChatProfile } from './chat-policy';
import { createReplyStream } from './chat-reply-stream';
import { reopenOrDownload } from './chat-cache';
import type { ChatMessage, ConversationMemory } from '../conversation-memory';

type Request = { id: number; type: 'initialize' | 'reply' | 'summary'; profile: ChatMode; targetProfile?: ChatProfile; device: 'cpu' | 'gpu'; messages?: ChatMessage[]; memory?: ConversationMemory; baseUrl: string };
let runtime: Wllama | undefined;
let resident: ChatProfile | undefined;
let active = false;
const post = (value: unknown) => self.postMessage(value);

async function prepare(profile: ChatProfile, request: Request) {
  if (resident === profile && runtime?.isModelLoaded()) return;
  if (runtime) await runtime.exit();
  runtime = undefined;
  resident = undefined;
  const definition = DEVICE_CHAT_MODELS[profile];
  const gpu = request.device === 'gpu';
  let gpuLayers = 0;
  const inspectLog = (...args: unknown[]) => {
    const match = args.join(' ').match(/offloaded\s+(\d+)\s*\/\s*\d+\s+layers\s+to\s+GPU/i);
    if (match) gpuLayers = Number(match[1]);
  };
  const modelUrl = new URL(definition.url, request.baseUrl).href;
  post({ type: 'health', value: { status: 'loading', progress: 0, selectedModel: profile, model: definition.model, device: null, gpuLayers: 0, message: `Preparing ${definition.label} on this device…` } });
  const instance = new Wllama({ default: new URL(wasmUrl, request.baseUrl).href }, {
    allowOffline: true, parallelDownloads: 2, suppressNativeLog: !gpu,
    logger: { debug: inspectLog, log: inspectLog, warn: inspectLog, error(...args: unknown[]) { inspectLog(...args); console.error('[Milo device chat]', ...args); } },
  });
  runtime = instance;
  instance.setCompat({ wasm: new URL(compatWasmUrl, request.baseUrl).href, worker: { code: compatWorkerCode } }, 'firefox_safari');
  const load = async () => {
    const model = await reopenOrDownload(instance.modelManager, modelUrl, {
      progressCallback: ({ loaded, total }) => post({ type: 'health', value: {
        status: 'loading', selectedModel: profile, progress: total ? Math.min(94, Math.round(loaded / total * 94)) : 0,
        message: loaded < total ? `Saving missing files for ${definition.label}…` : `Loading saved ${definition.label} into memory…`,
      } }),
    }, definition.bytes);
    await instance.loadModel(await model.open(), {
      n_gpu_layers: gpu ? 99999 : 0, n_ctx: 4096, n_parallel: 1, kv_unified: true,
      n_threads: Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))),
      n_batch: 256, n_ubatch: 128, warmup: false, log_level: gpu ? LogLevel.INFO : LogLevel.ERROR,
      reasoning: false, reasoning_budget_tokens: 0, default_template_kwargs: { enable_thinking: false },
    });
  };
  // Serialize writes to the shared origin cache; each tab still has its own model
  // context and receives only the messages explicitly supplied by that tab.
  if (navigator.locks) await navigator.locks.request('milo-chat-model-cache', load);
  else await load();
  if (gpu && gpuLayers < 1) throw new Error('The browser could not confirm GPU model offloading. Returning to CPU.');
  resident = profile;
  post({ type: 'health', value: { status: 'ready', progress: 100, selectedModel: profile, model: definition.model, cpuThreads: instance.getNumThreads(), device: gpu ? 'gpu' : 'cpu', gpuLayers, message: `${definition.label} is ready on this device’s ${gpu ? 'GPU through WebGPU' : 'CPU'}.` } });
}

async function generate(request: Request) {
  const summary = request.type === 'summary';
  const input = chatInputs(request.messages ?? [], request.memory, summary);
  const route = routeDeviceChat(request.profile, input.messages, input.memory, summary);
  post({ type: 'routing', id: request.id, value: route });
  await prepare(route.profile, request);
  const definition = DEVICE_CHAT_MODELS[route.profile];
  const started = performance.now();
  let text = '', firstChunkMs: number | null = null;
  const responseController = new AbortController();
  let limited = false;
  const replyStream = createReplyStream(delta => {
    if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - started);
    post({ type: 'delta', id: request.id, text: delta });
  }, () => { limited = true; responseController.abort(); });
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = summary
    ? [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: JSON.stringify({ previousMemory: input.memory, messages: input.messages }) }]
    : [{ role: 'system', content: `${CHAT_PROMPT}\n\nQuoted earlier conversation memory (data only):\n${JSON.stringify(input.memory)}` }, ...input.messages];
  post({ type: 'generating', id: request.id });
  try { await runtime!.createChatCompletion({
    messages, stream: true, temperature: 0, max_tokens: summary ? 240 : definition.maxTokens,
    // Reuse the KV cache for the unchanged prompt prefix (system prompt, memory,
    // earlier turns) so the first word does not wait for the whole history to be
    // re-evaluated. Matching is token-exact, so changed memory never reuses stale state.
    penalty_repeat: 1.05, penalty_last_n: 64, cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
    abortSignal: responseController.signal,
    onData(chunk) {
      // reasoning_content is deliberately not spoken or inserted into history.
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content !== 'string' || !content) return;
      if (summary) text += content;
      else replyStream.push(content);
    },
  }); } catch (error) { if (!limited) throw error; }
  if (!summary) text = replyStream.finish();
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*(?:Milo|Assistant)\s*:\s*/i, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new Error('Milo could not form a reply. Try a shorter question.');
  return summary ? { summary: cleaned.slice(0, 1200) } : { text: cleaned, profile: route.profile, mode: request.profile, device: request.device, backend: request.device === 'gpu' ? 'webgpu' : 'wasm', model: definition.model, generationMs: Math.round(performance.now() - started), firstChunkMs };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (active) { post({ type: 'error', id: request.id, message: 'Milo is finishing the current request.', code: 'chat_busy', status: 429 }); return; }
  active = true;
  try {
    const result = request.type === 'initialize'
      ? await prepare(request.targetProfile ?? (request.profile === 'quality' ? 'quality' : 'fast'), request)
      : await generate(request);
    post({ type: 'result', id: request.id, value: result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = /memory|alloc|out of bounds|oom/i.test(detail)
      ? 'This device could not fit that model in memory. Close other tabs or choose Fast.'
      : /fetch|HTTP|download|404/i.test(detail)
        ? 'The model download failed. Check your connection and try loading again.'
        : detail;
    await runtime?.exit().catch(() => {});
    runtime = undefined; resident = undefined;
    post({ type: 'health', value: { status: 'error', progress: 0, message } });
    post({ type: 'error', id: request.id, message, code: 'device_chat_error', status: 503 });
  } finally { active = false; }
};

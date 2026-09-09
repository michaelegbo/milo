import type { ChatMessage, ConversationMemory } from '../conversation-memory';
import type { ChatMode, ChatProfile, ChatRoute } from './chat-policy';
import { describeGpuAdapter } from './gpu-info';
export { DEVICE_CHAT_MODELS } from './chat-models';
export type { ChatMode, ChatProfile, ChatRoute } from './chat-policy';

type Reply = { text: string; profile: ChatProfile; mode: ChatMode; device: 'cpu' | 'gpu'; backend: 'wasm' | 'webgpu'; model: string; generationMs: number; firstChunkMs: number | null };
type Options = { profile?: ChatMode; targetProfile?: ChatProfile; memory?: ConversationMemory; signal?: AbortSignal; onRouting?: (route: ChatRoute) => void; onTextChunk?: (text: string) => void };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void; generating: () => void; options: Options };
type Acceleration = { available: boolean; enabled: boolean; status: 'detecting' | 'ready' | 'switching' | 'unavailable' | 'error'; backend: 'webgpu' | null; deviceName: string | null; deviceInfo?: string | null; revision: number; message: string };
type EngineHealth = { status: string; progress: number; message: string; profile: ChatMode; selectedModel: ChatProfile | null; model: string; device: 'cpu' | 'gpu' | null; gpuLayers?: number; cpuThreads?: number; queueDepth: number; residency: 'single'; residencyReason: string; acceleration: Acceleration };

class DeviceChatClient {
  private worker?: Worker;
  private sequence = 0;
  private gpuRevision = 0;
  private wantGpu = false;
  private detection?: Promise<void>;
  private pending = new Map<number, Pending>();
  private state: EngineHealth = {
    status: 'unloaded', progress: 0, message: 'Download a model to start private conversation on this device.',
    profile: 'fast', selectedModel: null, model: 'Qwen', device: 'cpu', queueDepth: 0,
    residency: 'single', residencyReason: 'One model stays in memory. Hybrid loads the other model from browser storage when needed.',
    acceleration: { available: false, enabled: false, status: 'detecting', backend: null, deviceName: null, revision: 0, message: 'Browser GPU support is checked when you start conversation.' },
  };

  health() { return { ...this.state, queueDepth: this.pending.size, acceleration: { ...this.state.acceleration } }; }

  private connect() {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' || !globalThis.isSecureContext) throw new Error('Use a current browser over HTTPS to run Milo on your device.');
    const worker = new Worker(new URL('./chat-worker.ts', import.meta.url), { type: 'module', name: 'milo-device-chat' });
    this.worker = worker;
    worker.onmessage = event => {
      if (worker !== this.worker) return;
      const data = event.data;
      if (data.type === 'health') {
        this.state = { ...this.state, ...data.value };
        if (data.value.status === 'ready') this.state.acceleration.enabled = data.value.device === 'gpu';
        if (data.value.status === 'error') {
          const gpuFailed = this.wantGpu;
          this.wantGpu = false;
          this.state.acceleration = { ...this.state.acceleration, enabled: false, status: 'error',
            message: gpuFailed ? 'The GPU model stopped. Reload to continue on CPU, or try GPU again afterward.' : this.state.acceleration.message };
        }
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.type === 'generating') { pending.generating(); return; }
      if (data.type === 'routing') { pending.options.onRouting?.(data.value); return; }
      if (data.type === 'delta') { pending.options.onTextChunk?.(data.text); return; }
      this.pending.delete(data.id); pending.cleanup();
      if (data.type === 'error') pending.reject(Object.assign(new Error(data.message), { code: data.code, status: data.status }));
      else pending.resolve(data.value);
    };
    worker.onerror = () => { if (worker === this.worker) this.reset(new Error('The device conversation worker stopped. Try loading again.'), 'error'); };
    worker.onmessageerror = () => { if (worker === this.worker) this.reset(new Error('The browser could not receive the conversation result.'), 'error'); };
    return worker;
  }

  private reset(error: Error = new DOMException('Conversation stopped.', 'AbortError'), status = 'unloaded') {
    const worker = this.worker;
    this.worker = undefined;
    this.wantGpu = false;
    // Terminating this worker also terminates its descendant llama/pthread workers.
    // It settles callers immediately even if native WASM is still inside a token.
    worker?.terminate();
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    this.state = { ...this.state, status, selectedModel: null, device: 'cpu', gpuLayers: 0, progress: 0, message: status === 'error' ? error.message : 'Conversation stopped. Load the model again to continue; downloaded files stay in this browser.', acceleration: { ...this.state.acceleration, enabled: false,
      status: this.state.acceleration.status === 'switching' ? this.state.acceleration.available ? 'ready' : 'unavailable' : this.state.acceleration.status,
      message: 'Model memory released. Reload to continue on CPU; GPU can be enabled again afterward.' } };
  }

  private request<T>(type: 'initialize' | 'reply' | 'summary', messages: ChatMessage[] | undefined, options: Options): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Stopped.', 'AbortError'));
    if (this.pending.size) return Promise.reject(Object.assign(new Error('Milo is finishing the current request. Please wait or stop it.'), { status: 429, code: 'chat_busy' }));
    let worker: Worker;
    try { worker = this.connect(); } catch (error) { this.state = { ...this.state, status: 'error', message: (error as Error).message }; return Promise.reject(error); }
    const profile = options.profile ?? this.state.profile;
    if (!['fast', 'quality', 'hybrid'].includes(profile)) return Promise.reject(new Error('Choose Fast, Quality, or Hybrid.'));
    this.state.profile = profile;
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.reset(new DOMException('Conversation stopped.', 'AbortError'));
      // Cold downloads can take minutes; inference itself gets a shorter bound.
      const expired = () => this.reset(new Error('The model took too long on this device. Try Fast or close other tabs.'), 'error');
      let timeout = setTimeout(expired, 20 * 60_000);
      const generating = () => { clearTimeout(timeout); timeout = setTimeout(expired, 5 * 60_000); };
      const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup, generating, options });
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ id, type, profile, targetProfile: options.targetProfile, device: this.wantGpu ? 'gpu' : 'cpu', messages, memory: options.memory, baseUrl: document.baseURI });
    });
  }

  private detectGpu() {
    this.detection ??= (async () => {
      type Adapter = Parameters<typeof describeGpuAdapter>[0];
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(options: { powerPreference: string; forceFallbackAdapter: boolean }): Promise<Adapter | null> } }).gpu;
      let details = describeGpuAdapter(null);
      try {
        const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false });
        details = describeGpuAdapter(adapter);
      } catch { /* CPU remains usable when browser GPU permission/driver fails. */ }
      const { available } = details;
      this.state.acceleration = { ...this.state.acceleration, ...details, backend: available ? 'webgpu' : null,
        status: this.state.acceleration.status === 'switching' ? 'switching' : available ? 'ready' : 'unavailable',
        message: available ? 'Compatible browser GPU detected. Turn on to accelerate replies on this device.' : 'A compatible browser GPU is unavailable. Replies run on this device’s CPU.' };
    })();
    return this.detection;
  }

  initialize(options: { profile: ChatMode; signal?: AbortSignal }) { void this.detectGpu(); return this.request<void>('initialize', undefined, options); }
  reply(messages: ChatMessage[], options: Options = {}) { return this.request<Reply>('reply', messages, options); }
  summarize(messages: ChatMessage[], options: Options = {}) { return this.request<{ summary: string }>('summary', messages, options); }
  async setAcceleration(enabled: boolean, options: { signal?: AbortSignal } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('GPU acceleration must be on or off.');
    options.signal?.throwIfAborted();
    const revision = ++this.gpuRevision;
    const profile = this.state.profile;
    const targetProfile = this.state.selectedModel ?? (profile === 'quality' ? 'quality' : 'fast');
    this.reset();
    this.wantGpu = enabled;
    this.state.acceleration = { ...this.state.acceleration, revision, status: 'switching', message: enabled ? 'Preparing the model on this device’s GPU…' : 'Releasing GPU memory and preparing CPU…' };
    const current = () => { options.signal?.throwIfAborted(); if (revision !== this.gpuRevision) throw new DOMException('Superseded by a newer device choice.', 'AbortError'); };
    try {
      if (enabled) { await this.detectGpu(); current(); if (!this.state.acceleration.available) throw new Error('A compatible browser GPU is unavailable.'); }
      current();
      await this.request<void>('initialize', undefined, { profile, targetProfile, signal: options.signal });
      current();
      this.state.acceleration = { ...this.state.acceleration, status: this.state.acceleration.available ? 'ready' : 'unavailable', enabled: this.state.device === 'gpu', message: enabled ? 'Replies use this device’s GPU. Voice and listening stay on CPU.' : 'GPU memory released. Replies use this device’s CPU.' };
    } catch (error) {
      if (revision !== this.gpuRevision) throw error;
      if (options.signal?.aborted || (error as Error).name === 'AbortError') { this.reset(); throw error; }
      if (!enabled) { this.state.acceleration.status = 'error'; throw error; }
      this.wantGpu = false;
      this.reset();
      this.state.acceleration = { ...this.state.acceleration, status: 'switching', message: 'GPU could not start. Restoring this device’s CPU…' };
      await this.request<void>('initialize', undefined, { profile, targetProfile, signal: options.signal });
      current();
      this.state.acceleration = { ...this.state.acceleration, enabled: false, status: 'error', message: `GPU could not start. CPU is ready. ${(error as Error).message}` };
    }
  }
  dispose() { ++this.gpuRevision; this.wantGpu = false; this.reset(); if (this.state.acceleration.status === 'switching') this.state.acceleration.status = this.state.acceleration.available ? 'ready' : 'unavailable'; }
}

export const deviceChat = new DeviceChatClient();

export type AudioKind = 'tts' | 'stt';
export type AudioHealth = {
  status: 'unloaded' | 'loading' | 'ready' | 'error'; progress: number | null;
  message: string; model: string; device: 'cpu'; backend: 'wasm'; offline: boolean;
  busy: boolean; downloadBytes: number;
};
export type AudioHealthSnapshot = { tts: AudioHealth; stt: AudioHealth };
export type SpeechRequest = { text: string; voice?: string; speed?: number };
export type SpeechResult = { wav: Blob; duration: number; generationMs: number; cached: boolean };
export type TranscriptionResult = { text: string; duration: number; transcriptionMs: number };
type Options = { signal?: AbortSignal };
type WorkerReply = { id?: number; health?: Partial<AudioHealth>; result?: unknown; error?: string };

const MODELS = {
  tts: { model: 'onnx-community/Kokoro-82M-v1.0-ONNX', downloadBytes: 92_000_000 },
  stt: { model: 'Xenova/whisper-base.en', downloadBytes: 80_000_000 },
};
const initialHealth = (kind: AudioKind): AudioHealth => ({ ...MODELS[kind], status: 'unloaded', progress: null, message: `${kind === 'tts' ? 'Voice' : 'Listening'} has not been downloaded on this device.`, device: 'cpu', backend: 'wasm', offline: false, busy: false });
const cancelled = () => new DOMException('The device operation was cancelled.', 'AbortError');

class AudioChannel {
  state: AudioHealth;
  private worker?: Worker;
  private sequence = 0;
  private pending?: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };
  private initialization?: Promise<void>;

  constructor(private kind: AudioKind, private changed: () => void) { this.state = initialHealth(kind); }

  private start() {
    if (this.worker) return;
    if (!globalThis.isSecureContext || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') throw new Error('Device voice needs a secure browser with WebAssembly and Web Workers. Try a recent desktop browser.');
    const worker = new Worker(new URL('./audio-worker.ts', import.meta.url), { type: 'module', name: `milo-${this.kind}` });
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (this.worker !== worker) return;
      if (data.health) { this.state = { ...this.state, ...data.health }; this.changed(); }
      const pending = this.pending;
      if (!pending || pending.id !== data.id) return;
      this.pending = undefined; pending.cleanup(); this.state.busy = false;
      if (data.error) {
        const error = new Error(data.error);
        pending.reject(error);
        // A partially initialized native session must not survive a failed
        // startup and consume memory again on the next retry.
        if (this.state.status === 'error') this.reset(error, true);
      } else pending.resolve(data.result);
      this.changed();
    };
    worker.onerror = event => {
      event.preventDefault();
      if (this.worker !== worker) return;
      this.reset(new Error('The device audio worker stopped. Close other busy tabs and try loading again.'), true);
    };
    worker.onmessageerror = () => { if (this.worker === worker) this.reset(new Error('The device audio worker could not read a message. Try loading again.'), true); };
  }

  private reset(error: Error, failed = false) {
    this.worker?.terminate(); this.worker = undefined; this.initialization = undefined;
    const pending = this.pending; this.pending = undefined;
    pending?.cleanup(); pending?.reject(error);
    this.state = { ...initialHealth(this.kind), ...(failed ? { status: 'error', message: error.message } : { message: 'Stopped. Models already cached by this browser can be reused when you start again.' }) };
    this.changed();
  }

  private run<T>(type: string, payload: object = {}, { signal }: Options = {}, timeoutMs = 120_000): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.pending) return Promise.reject(new Error('This device audio engine is busy. Wait for the current operation or stop it first.'));
    try { this.start(); } catch (error) { return Promise.reject(error); }
    const id = ++this.sequence;
    this.state.busy = true; this.changed();
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.reset(cancelled());
      const timer = window.setTimeout(() => this.reset(new Error(type === 'initialize' ? 'The model download or startup took too long. Check your connection and available storage, then retry.' : 'This device took too long to process the audio. Try a shorter message.'), true), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending = { id, resolve: value => resolve(value as T), reject, cleanup };
      signal?.addEventListener('abort', abort, { once: true });
      try { this.worker!.postMessage({ id, type, kind: this.kind, ...payload }); }
      catch (error) { this.reset(error instanceof Error ? error : new Error('The device audio request failed.'), true); }
    });
  }

  async initialize(options: Options = {}) {
    if (options.signal?.aborted) throw cancelled();
    if (this.state.status === 'ready') return;
    if (!this.initialization) {
      const pending = this.run<void>('initialize', {}, options, 20 * 60_000);
      this.initialization = pending;
      void pending.finally(() => { if (this.initialization === pending) this.initialization = undefined; }).catch(() => {});
    }
    // A second UI subscriber must not cancel another caller's initialization.
    const pending = this.initialization;
    if (!options.signal) return pending;
    let abort: () => void = () => {};
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => reject(cancelled());
        options.signal!.addEventListener('abort', abort, { once: true });
        if (options.signal!.aborted) abort();
      })]);
    } finally { options.signal.removeEventListener('abort', abort); }
  }

  async perform<T>(type: string, payload: object, options: Options) {
    await this.initialize(options);
    return this.run<T>(type, payload, options);
  }

  dispose() { this.reset(cancelled()); }
}

/** Models and all inference remain in this tab's workers. No server fallback. */
export class DeviceAudioClient {
  private listeners = new Set<(health: AudioHealthSnapshot) => void>();
  private channels = {
    tts: new AudioChannel('tts', () => this.notify()),
    stt: new AudioChannel('stt', () => this.notify()),
  };
  health(): AudioHealthSnapshot { return { tts: { ...this.channels.tts.state }, stt: { ...this.channels.stt.state } }; }
  subscribe(listener: (health: AudioHealthSnapshot) => void) {
    this.listeners.add(listener); listener(this.health());
    return () => this.listeners.delete(listener);
  }
  private notify() { for (const listener of this.listeners) listener(this.health()); }
  async initialize(kind: AudioKind | 'both' = 'both', options: Options = {}) {
    // Sequential initialization avoids simultaneous large model allocations.
    for (const item of kind === 'both' ? ['tts', 'stt'] as const : [kind]) await this.channels[item].initialize(options);
  }
  async generate(request: SpeechRequest, options: Options = {}): Promise<SpeechResult> {
    if (!request || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 600) throw new Error('Enter a sentence of 1 to 600 characters.');
    if (!['af_heart', 'am_michael', 'bf_emma'].includes(request.voice ?? 'af_heart') || (request.speed != null && (!Number.isFinite(request.speed) || request.speed < 0.7 || request.speed > 1.3))) throw new Error('Choose a supported voice and speed between 0.7 and 1.3.');
    const result = await this.channels.tts.perform<Omit<SpeechResult, 'wav'> & { wav: ArrayBuffer }>('generate', { request }, options);
    return { ...result, wav: new Blob([result.wav], { type: 'audio/wav' }) };
  }
  async transcribe(wav: Blob | ArrayBuffer, options: Options = {}): Promise<TranscriptionResult> {
    if ((wav instanceof Blob ? wav.size : wav.byteLength) > 1_000_000) throw new Error('Keep voice messages under 30 seconds.');
    const bytes = wav instanceof Blob ? await wav.arrayBuffer() : wav;
    return this.channels.stt.perform<TranscriptionResult>('transcribe', { wav: bytes }, options);
  }
  dispose(kind?: AudioKind) {
    for (const item of kind ? [kind] : ['tts', 'stt'] as const) this.channels[item].dispose();
  }
}

export const deviceAudio = new DeviceAudioClient();

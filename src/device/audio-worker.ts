import { env, pipeline, Tensor, RawAudio, type AutomaticSpeechRecognitionPipeline, type ProgressCallback } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { AUDIO_FILES, audioFileUrl } from './saved-downloads';
import type { AudioHealth, AudioKind, SpeechRequest } from './audio-client';

type Request = { id: number; type: 'initialize' | 'generate' | 'transcribe'; kind: AudioKind; request?: SpeechRequest; wav?: ArrayBuffer };
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<Request>) => void; postMessage: (value: unknown, transfer?: Transferable[]) => void };
const TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const STT_MODEL = 'Xenova/whisper-base.en';
const VOICES = ['af_heart', 'am_michael', 'bf_emma'] as const;
type Voice = typeof VOICES[number];
let tts: KokoroTTS | undefined;
let stt: AutomaticSpeechRecognitionPipeline | undefined;
let busy = false;
let ready = false;
let kind: AudioKind;
const savedFiles = new Set<string>();
const audioCache = new Map<string, { wav: ArrayBuffer; duration: number }>();
let cacheBytes = 0;

// The runtime is shipped by Milo. Models are downloaded only after an explicit
// client request; these GET requests contain no microphone audio or chat text.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useFS = false;
env.useFSCache = false;
env.backends.onnx.wasm!.wasmPaths = new URL('/runtime/ort/', globalThis.location.origin).href;
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
if (import.meta.env.VITE_AUDIO_MODEL_BASE) {
  env.remoteHost = new URL(import.meta.env.VITE_AUDIO_MODEL_BASE, globalThis.location.origin).href.replace(/\/?$/, '/');
  env.remotePathTemplate = '{model}/';
}

function report(health: Partial<AudioHealth>) { scope.postMessage({ health }); }
function progressFor(label: string, expectedBytes: number): ProgressCallback {
  const files = new Map<string, { loaded: number; total: number }>();
  return event => {
    if (event.status === 'progress' && event.file.endsWith('.onnx')) {
      files.set(event.file, { loaded: event.loaded, total: event.total });
      const loaded = [...files.values()].reduce((sum, file) => sum + file.loaded, 0);
      const total = Math.max(expectedBytes, [...files.values()].reduce((sum, file) => sum + file.total, 0));
      const progress = Math.min(98, Math.round(loaded / total * 100));
      report({ status: 'loading', progress, message: savedFiles.has(event.file) ? `Loading saved ${label} into memory: ${progress}%.` : `Downloading ${label} to this device: ${progress}%.` });
    } else if (event.status === 'done') report({ status: 'loading', message: `Preparing ${label} in this browser…` });
  };
}

async function initialize() {
  if (ready) return;
  if ('caches' in globalThis) {
    try {
      const cache = await caches.open('transformers-cache');
      const definition = AUDIO_FILES[kind === 'tts' ? 'tts' : 'stt'];
      for (const file of definition.files) if (await cache.match(audioFileUrl(definition.model, file))) savedFiles.add(file);
    } catch { /* Inference can still report a storage failure through setup. */ }
  }
  report({ status: 'loading', progress: 0, message: `Loading ${kind === 'tts' ? 'Kokoro voice' : 'Whisper listening'} on this device…` });
  if (kind === 'tts') {
    tts = await KokoroTTS.from_pretrained(TTS_MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progressFor('Kokoro', 92_000_000) });
    const voices = new Map<string, Float32Array>();
    // Kokoro's default implementation hardcodes remote voice-vector URLs.
    // Use the same inference inputs with Milo's bundled, same-origin vectors.
    tts.generate_from_ids = async (inputIds, { voice = 'af_heart', speed = 1 } = {}) => {
      if (!VOICES.includes(voice as Voice)) throw new Error('Choose Heart, Michael, or Emma.');
      let data = voices.get(voice);
      if (!data) {
        const response = await fetch(`/runtime/voices/${voice}.bin`);
        if (!response.ok) throw new Error('The bundled voice could not load. Reload Milo and try again.');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== 510 * 256 * 4) throw new Error('The bundled voice data is incomplete. Reload Milo and try again.');
        data = new Float32Array(bytes); voices.set(voice, data);
      }
      const offset = 256 * Math.min(Math.max(inputIds.dims.at(-1)! - 2, 0), 509);
      const output = await tts!.model({ input_ids: inputIds, style: new Tensor('float32', data.slice(offset, offset + 256), [1, 256]), speed: new Tensor('float32', [speed], [1]) });
      return new RawAudio(output.waveform.data as Float32Array, 24000);
    };
    const tokenizer = tts.tokenizer;
    tts.tokenizer = new Proxy(tokenizer, {
      apply(target, thisArg, [text, options]) {
        const tokens = Reflect.apply(target, thisArg, [text, { ...options, truncation: false }]);
        if (tokens.input_ids.dims.at(-1) > 512) throw new Error('That sentence expands beyond the voice model limit. Shorten long numbers or spelled-out acronyms.');
        return tokens;
      },
    });
    report({ progress: 99, message: 'Checking voice generation on this device…' });
    const warmup = await tts.generate('Ready.', { voice: 'af_heart' });
    if (!warmup.audio.length) throw new Error('Voice generation returned no audio on this device.');
  } else {
    // Narrow Transformers' very large task union before invoking this known
    // pipeline, rather than instantiating every model type in TypeScript.
    const createTranscriber = pipeline as unknown as (task: 'automatic-speech-recognition', model: string, options: { dtype: 'q8'; device: 'wasm'; progress_callback: ProgressCallback }) => Promise<AutomaticSpeechRecognitionPipeline>;
    stt = await createTranscriber('automatic-speech-recognition', STT_MODEL, {
      dtype: 'q8', device: 'wasm', progress_callback: progressFor('Whisper', 80_000_000),
    });
  }
  ready = true;
  report({ status: 'ready', progress: 100, offline: true, message: `${kind === 'tts' ? 'Voice' : 'Listening'} is ready on this device.` });
}

function encodeWav(samples: Float32Array, rate = 24000): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const write = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

function decodeWav(bytes: ArrayBuffer) {
  const invalid = () => new Error('Use a 16 kHz mono PCM16 WAV recording.');
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 44 || bytes.byteLength > 1_000_000) throw invalid();
  const view = new DataView(bytes);
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) throw invalid();
  let dataOffset = 0, dataSize = 0, validFormat = false;
  let offset = 12;
  for (; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true), end = offset + 8 + size;
    if (end > bytes.byteLength) throw invalid();
    if (tag(offset) === 'fmt ') {
      if (validFormat || size < 16 || view.getUint16(offset + 8, true) !== 1 || view.getUint16(offset + 10, true) !== 1 || view.getUint32(offset + 12, true) !== 16000 || view.getUint32(offset + 16, true) !== 32000 || view.getUint16(offset + 20, true) !== 2 || view.getUint16(offset + 22, true) !== 16) throw invalid();
      validFormat = true;
    } else if (tag(offset) === 'data') {
      if (dataOffset) throw invalid();
      dataOffset = offset + 8; dataSize = size;
    }
    offset = end + size % 2;
  }
  if (offset !== bytes.byteLength || !validFormat || !dataOffset || !dataSize || dataSize % 2) throw invalid();
  const duration = dataSize / 32000;
  if (duration < 0.2 || duration > 30) throw new Error('Record between 0.2 and 30 seconds of speech.');
  const samples = new Float32Array(dataSize / 2);
  let energy = 0;
  for (let i = 0; i < samples.length; i++) { samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768; energy += samples[i] ** 2; }
  if (Math.sqrt(energy / samples.length) < 0.003) throw new Error('No speech heard. Move closer to the microphone and try again.');
  return { samples, duration };
}

function splitText(text: string) {
  const chunks: string[] = [];
  const parts = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text), part => part.segment.trim()) : [text];
  for (let part of parts) {
    while (part.length > 180) {
      const boundary = part.lastIndexOf(' ', 180);
      const end = boundary > 0 ? boundary : 180;
      chunks.push(part.slice(0, end).trim()); part = part.slice(end).trim();
    }
    if (part) chunks.push(part);
  }
  return chunks;
}

async function generate(input?: SpeechRequest) {
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 600) throw new Error('Enter a sentence of 1 to 600 characters.');
  const voice = input.voice ?? 'af_heart', speed = input.speed ?? 1;
  if (!VOICES.includes(voice as Voice) || typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.7 || speed > 1.3) throw new Error('Choose a supported voice and a speed between 0.7 and 1.3.');
  const text = input.text.replace(/\s+/g, ' ').trim();
  const key = JSON.stringify({ text, voice, speed });
  const cached = audioCache.get(key);
  if (cached) return { ...cached, wav: cached.wav.slice(0), generationMs: 0, cached: true };
  const start = performance.now();
  const generated: Float32Array[] = [];
  for (const part of splitText(text)) {
    const audio = await tts!.generate(part, { voice: voice as Voice, speed });
    if (!audio.audio.length) throw new Error('No audio was generated. Try a shorter sentence.');
    generated.push(audio.audio);
  }
  const samples = new Float32Array(generated.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of generated) { samples.set(part, offset); offset += part.length; }
  const result = { wav: encodeWav(samples), duration: samples.length / 24000 };
  while (audioCache.size && (audioCache.size >= 12 || cacheBytes + result.wav.byteLength > 16 * 1024 * 1024)) {
    const oldest = audioCache.keys().next().value!;
    cacheBytes -= audioCache.get(oldest)!.wav.byteLength; audioCache.delete(oldest);
  }
  if (result.wav.byteLength <= 16 * 1024 * 1024) { audioCache.set(key, result); cacheBytes += result.wav.byteLength; }
  return { ...result, wav: result.wav.slice(0), generationMs: Math.round(performance.now() - start), cached: false };
}

scope.onmessage = async ({ data }) => {
  if (busy) { scope.postMessage({ id: data.id, error: 'The device audio engine is busy. Try again shortly.' }); return; }
  busy = true;
  try {
    if (kind && kind !== data.kind) throw new Error('Audio worker type mismatch.');
    kind = data.kind;
    await initialize();
    if (data.type === 'initialize') { scope.postMessage({ id: data.id, result: true }); return; }
    if (data.type === 'generate' && kind === 'tts') {
      const result = await generate(data.request);
      scope.postMessage({ id: data.id, result }, [result.wav]);
    } else if (data.type === 'transcribe' && kind === 'stt') {
      const { samples, duration } = decodeWav(data.wav!);
      const started = performance.now();
      const output = await stt!(samples, { return_timestamps: false, max_new_tokens: 256, do_sample: false });
      const text = (Array.isArray(output) ? output[0].text : output.text).replace(/\s+/g, ' ').trim();
      if (!text) throw new Error('No speech recognized. Try speaking a little closer to the microphone.');
      scope.postMessage({ id: data.id, result: { text, duration, transcriptionMs: Math.round(performance.now() - started) } });
    } else throw new Error('Unsupported device audio operation.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Audio processing failed on this device.';
    if (!ready) report({ status: 'error', progress: null, message: 'The device audio model could not start. Check available memory and storage, then try again.', offline: false });
    scope.postMessage({ id: data.id, error: message });
  } finally { busy = false; }
};

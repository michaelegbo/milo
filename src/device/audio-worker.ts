import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressCallback } from '@huggingface/transformers';
import { AUDIO_FILES, audioFileUrl } from './saved-downloads';
import type { AudioHealth, AudioKind } from './audio-client';

// Whisper listening only. Milo's voice is Deepgram; no speech model is loaded or bundled here.
type Request = { id: number; type: 'initialize' | 'transcribe'; kind: AudioKind; wav?: ArrayBuffer };
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<Request>) => void; postMessage: (value: unknown, transfer?: Transferable[]) => void };
const STT_MODEL = 'Xenova/whisper-base.en';
let stt: AutomaticSpeechRecognitionPipeline | undefined;
let busy = false;
let ready = false;
let kind: AudioKind;
const savedFiles = new Set<string>();
// The runtime is shipped by Milo. Models are downloaded only after an explicit
// client request; these GET requests contain no microphone audio or chat text.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useFS = false;
env.useFSCache = false;
env.backends.onnx.wasm!.wasmPaths = new URL('/runtime/ort/', globalThis.location.origin).href;
// Cross-origin isolation exposes SharedArrayBuffer, which lets ONNX Runtime run
// Whisper across a few CPU threads. Each audio worker keeps to a small
// share so the reply model and the page itself still have cores available.
env.backends.onnx.wasm!.numThreads = typeof SharedArrayBuffer === 'undefined' ? 1 : Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
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
      const definition = AUDIO_FILES.stt;
      for (const file of definition.files) if (await cache.match(audioFileUrl(definition.model, file))) savedFiles.add(file);
    } catch { /* Inference can still report a storage failure through setup. */ }
  }
  report({ status: 'loading', progress: 0, message: 'Loading Whisper listening on this device…' });
  // Narrow Transformers' very large task union before invoking this known
  // pipeline, rather than instantiating every model type in TypeScript.
  const createTranscriber = pipeline as unknown as (task: 'automatic-speech-recognition', model: string, options: { dtype: 'q8'; device: 'wasm'; progress_callback: ProgressCallback }) => Promise<AutomaticSpeechRecognitionPipeline>;
  stt = await createTranscriber('automatic-speech-recognition', STT_MODEL, {
    dtype: 'q8', device: 'wasm', progress_callback: progressFor('Whisper', 80_000_000),
  });
  ready = true;
  report({ status: 'ready', progress: 100, offline: true, message: 'Listening is ready on this device.' });
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

scope.onmessage = async ({ data }) => {
  if (busy) { scope.postMessage({ id: data.id, error: 'The device audio engine is busy. Try again shortly.' }); return; }
  busy = true;
  try {
    if (kind && kind !== data.kind) throw new Error('Audio worker type mismatch.');
    kind = data.kind;
    await initialize();
    if (data.type === 'initialize') { scope.postMessage({ id: data.id, result: true }); return; }
    if (data.type === 'transcribe' && kind === 'stt') {
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

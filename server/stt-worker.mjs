import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/whisper-base.en';
const CACHE_DIR = fileURLToPath(new URL('./.cache/stt/', import.meta.url));
const REQUIRED_FILES = ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'preprocessor_config.json', 'generation_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
let transcriber;
let initialization;
const send = (event) => { if (process.connected) process.send(event, () => {}); };
const report = (state) => send({ type: 'health', state });
// Avoid orphan model processes when the local server closes or crashes.
process.on('disconnect', () => process.exit(0));

async function initialize() {
  if (transcriber) return;
  if (initialization) return initialization;
  initialization = (async () => {
    // Process isolation is essential: Kokoro uses a different Transformers
    // cache and the native ONNX addon is not safe across Node worker threads.
    env.cacheDir = CACHE_DIR;
    const complete = (await Promise.all(REQUIRED_FILES.map(async (file) => {
      try { return (await stat(join(CACHE_DIR, MODEL_ID, file))).size > 0; }
      catch { return false; }
    }))).every(Boolean);
    const offline = process.env.STT_OFFLINE === '1' || complete;
    env.allowRemoteModels = !offline;
    const downloads = new Map();
    transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
      device: 'cpu',
      dtype: 'q8',
      local_files_only: offline,
      session_options: { intraOpNumThreads: Math.min(4, availableParallelism()), interOpNumThreads: 1 },
      progress_callback(event) {
        if (event.status === 'progress' && event.file?.endsWith('.onnx')) {
          downloads.set(event.file, { loaded: event.loaded ?? 0, total: event.total ?? 0 });
          const loaded = [...downloads.values()].reduce((sum, item) => sum + item.loaded, 0);
          const total = Math.max(77_000_000, [...downloads.values()].reduce((sum, item) => sum + item.total, 0));
          const progress = Math.min(99, Math.round(loaded / total * 100));
          report({ status: 'loading', progress, message: `Downloading Whisper for local listening: ${progress}%.` });
        } else if (event.status === 'done' && event.file?.endsWith('.onnx')) {
          report({ status: 'loading', message: 'Preparing the CPU listening engine.' });
        }
      },
    });
    env.allowRemoteModels = false;
    report({ status: 'ready', progress: 100, offline: true, message: 'Whisper is ready. Your microphone audio stays on this computer.' });
  })().catch((error) => {
    initialization = undefined;
    report({ status: 'error', progress: null, message: 'Whisper could not load. First use needs internet for the model download; try again.' });
    console.error('[stt] Initialization failed:', error.message);
    throw error;
  });
  return initialization;
}

process.on('message', async ({ id, type, samples, duration }) => {
  try {
    await initialize();
    if (type === 'initialize') return send({ id, result: true });
    if (type !== 'transcribe' || !(samples instanceof Float32Array)) throw new Error('Invalid transcription request.');
    const started = performance.now();
    const output = await transcriber(samples, { return_timestamps: false, max_new_tokens: 256, do_sample: false });
    const text = output.text.replace(/\s+/g, ' ').trim();
    send({ id, result: { text, duration, transcriptionMs: Math.round(performance.now() - started) } });
  } catch (error) {
    send({ id, error: { status: 503, code: type === 'initialize' ? 'stt_error' : 'transcription_failed', message: type === 'initialize' ? 'Whisper could not load. First use needs internet for the model download; try again.' : 'I could not transcribe that recording. Please try again.' } });
    console.error('[stt] Request failed:', error.message);
  }
});

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const VOICES = Object.freeze(['af_heart', 'am_michael', 'bf_emma']);
export const MAX_TEXT_LENGTH = 600;
export const MODEL_CACHE_DIR = fileURLToPath(new URL('./.cache/models/', import.meta.url));
const MODEL_FILES = ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'];
const MAX_PENDING = 3;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 24;

export class SpeechError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateSpeech(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SpeechError(400, 'invalid_request', 'Send a JSON object with text, voice, and speed.');
  }
  if (typeof body.text !== 'string' || !body.text.trim()) {
    throw new SpeechError(400, 'invalid_text', 'Add a sentence before generating speech.');
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    throw new SpeechError(400, 'text_too_long', `Keep your sentence within ${MAX_TEXT_LENGTH} characters.`);
  }
  const text = body.text.replace(/\s+/g, ' ').trim();
  const voice = body.voice ?? 'af_heart';
  const speed = body.speed ?? 1;
  if (!VOICES.includes(voice)) {
    throw new SpeechError(400, 'invalid_voice', 'Choose Heart, Michael, or Emma.');
  }
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.7 || speed > 1.3) {
    throw new SpeechError(400, 'invalid_speed', 'Speech speed must be between 0.7 and 1.3.');
  }
  return { text, voice, speed: Math.round(speed * 100) / 100 };
}

// Keep each inference short, retaining every word. A second, phoneme-token
// check below handles expansions such as spoken numbers and spelled acronyms.
export function splitText(text, maxLength = 180) {
  const sentences = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text), ({ segment }) => segment.trim());
  const chunks = [];
  for (let sentence of sentences) {
    while (sentence.length > maxLength) {
      const boundary = sentence.lastIndexOf(' ', maxLength);
      const at = boundary > 0 ? boundary : maxLength;
      chunks.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (sentence) chunks.push(sentence);
  }
  return chunks;
}

export function encodeWav(samples, sampleRate = 24000) {
  const bytes = samples.length * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    wav.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return wav;
}

export function createSpeechEngine() {
  let model;
  let initialization;
  let status = 'loading';
  let progress = null;
  let message = 'Loading the local speech engine. First launch downloads the model.';
  let active = false;
  let offline = false;
  let cacheBytes = 0;
  const queue = [];
  const cache = new Map();
  const inFlight = new Map();

  function health() {
    return { status, model: MODEL_ID, device: 'cpu', dtype: 'q8', progress, message, voices: VOICES, queueDepth: queue.length + Number(active), offline };
  }

  function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const [{ KokoroTTS }, { env }] = await Promise.all([import('kokoro-js'), import('@huggingface/transformers')]);
        // The published kokoro-js 1.2.1 env wrapper exposes only wasmPaths.
        // Configure the actual Transformers environment that owns model caching.
        env.cacheDir = MODEL_CACHE_DIR;
        const completeCache = (await Promise.all(MODEL_FILES.map(async (file) => {
          try { return (await stat(join(MODEL_CACHE_DIR, MODEL_ID, file))).size > 0; }
          catch { return false; }
        }))).every(Boolean);
        offline = process.env.SPEECH_OFFLINE === '1' || completeCache;
        env.allowRemoteModels = !offline;
        model = await KokoroTTS.from_pretrained(MODEL_ID, {
          device: 'cpu',
          dtype: 'q8',
          progress_callback(event) {
            if (event.status === 'progress' && event.file?.endsWith('.onnx')) {
              progress = Math.min(99, Math.round(event.progress ?? 0));
              message = `Downloading the speech model: ${progress}%.`;
            } else if (event.status === 'done' && event.file?.endsWith('.onnx')) {
              message = 'Preparing the CPU speech engine.';
            }
          },
        });
        // Kokoro's generate() phonemizes text before calling this tokenizer,
        // requesting truncation by default. Check that exact processed input
        // with truncation disabled, so accepted text can never silently lose
        // speech even when short numeric text expands into many phonemes.
        model.tokenizer = new Proxy(model.tokenizer, {
          apply(tokenizer, thisArg, [phonemes, options]) {
            const tokens = Reflect.apply(tokenizer, thisArg, [phonemes, { ...options, truncation: false }]);
            const sequenceLength = tokens.input_ids.dims.at(-1);
            if (sequenceLength > 512) {
              throw new SpeechError(400, 'text_too_complex', 'This sentence expands beyond the speech model\'s limit. Shorten long numbers or spelled-out acronyms and try again.');
            }
            return tokens;
          },
        });
        // A tiny warm-up proves that inference and the bundled phonemizer work.
        await model.generate('Ready.', { voice: 'af_heart', speed: 1 });
        env.allowRemoteModels = false;
        offline = true;
        status = 'ready';
        progress = 100;
        message = 'Kokoro is ready. Speech runs locally on your CPU.';
        console.log('[speech] Kokoro q8 is ready on CPU.');
      } catch (error) {
        status = 'error';
        progress = null;
        message = 'The speech engine could not start. Check the server terminal and restart; first launch needs internet to download the model.';
        console.error('[speech] Model initialization failed:', error);
      }
    })();
    return initialization;
  }

  function remember(key, result) {
    while (cache.size && (cacheBytes + result.wav.length > MAX_CACHE_BYTES || cache.size >= MAX_CACHE_ENTRIES)) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).wav.length;
      cache.delete(oldest);
    }
    if (result.wav.length <= MAX_CACHE_BYTES) {
      cache.set(key, result);
      cacheBytes += result.wav.length;
    }
  }

  async function processQueue() {
    if (active || !queue.length) return;
    active = true;
    const task = queue.shift();
    try {
      const started = performance.now();
      const chunks = splitText(task.request.text);
      const generated = [];
      let sampleRate = 24000;
      for (const text of chunks) {
        const audio = await model.generate(text, { voice: task.request.voice, speed: task.request.speed });
        if (!audio.audio?.length) throw new Error('The speech engine returned no audio.');
        sampleRate = audio.sampling_rate ?? 24000;
        generated.push(audio.audio);
      }
      // Sentence boundaries already contain natural pauses in model output.
      const samples = new Float32Array(generated.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of generated) {
        samples.set(part, offset);
        offset += part.length;
      }
      const result = { wav: encodeWav(samples, sampleRate), duration: samples.length / sampleRate, generationMs: Math.round(performance.now() - started), cached: false };
      remember(task.key, result);
      task.resolve(result);
    } catch (error) {
      if (error instanceof SpeechError) {
        task.reject(error);
      } else {
        console.error('[speech] Generation failed:', error);
        task.reject(new SpeechError(500, 'generation_failed', 'Speech generation failed. Try a shorter sentence or another voice.'));
      }
    } finally {
      inFlight.delete(task.key);
      active = false;
      void processQueue();
    }
  }

  function generate(body) {
    const request = validateSpeech(body);
    if (status !== 'ready') {
      throw new SpeechError(503, status === 'error' ? 'engine_error' : 'engine_loading', message);
    }
    const key = JSON.stringify(request);
    if (cache.has(key)) {
      const result = cache.get(key);
      cache.delete(key);
      cache.set(key, result);
      return Promise.resolve({ ...result, cached: true, generationMs: 0 });
    }
    if (inFlight.has(key)) return inFlight.get(key);
    if (queue.length + Number(active) >= MAX_PENDING) {
      throw new SpeechError(429, 'engine_busy', 'The CPU speech engine is busy. Try again in a moment.');
    }
    const promise = new Promise((resolve, reject) => queue.push({ key, request, resolve, reject }));
    inFlight.set(key, promise);
    void processQueue();
    return promise;
  }

  return { initialize, health, generate };
}

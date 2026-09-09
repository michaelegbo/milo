import { fork } from 'node:child_process';

export const STT_MODEL_ID = 'Xenova/whisper-base.en';
export const STT_SAMPLE_RATE = 16000;
export const STT_MAX_SECONDS = 30;
export const STT_MAX_BYTES = 1024 * 1024;

export class STTError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'STTError';
    this.status = status;
    this.code = code;
  }
}

/** Decode only the browser's deliberately narrow PCM WAV contract. */
export function decodeSTTWav(input) {
  const wav = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (wav.length > STT_MAX_BYTES) throw new STTError(413, 'audio_too_large', 'Record at most 30 seconds per turn.');
  const invalid = () => new STTError(400, 'invalid_audio', 'Send a 16 kHz mono PCM16 WAV recording.');
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) throw invalid();
  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > wav.length) throw invalid();
    if (kind === 'fmt ') {
      if (format || size < 16) throw invalid();
      format = {
        encoding: wav.readUInt16LE(offset + 8), channels: wav.readUInt16LE(offset + 10),
        rate: wav.readUInt32LE(offset + 12), byteRate: wav.readUInt32LE(offset + 16),
        align: wav.readUInt16LE(offset + 20), bits: wav.readUInt16LE(offset + 22),
      };
    } else if (kind === 'data') {
      if (data) throw invalid();
      data = wav.subarray(offset + 8, end);
    }
    offset = end + (size % 2);
  }
  if (offset !== wav.length || !format || !data || format.encoding !== 1 || format.channels !== 1 || format.rate !== STT_SAMPLE_RATE || format.byteRate !== STT_SAMPLE_RATE * 2 || format.align !== 2 || format.bits !== 16 || !data.length || data.length % 2) throw invalid();
  const duration = data.length / 2 / STT_SAMPLE_RATE;
  if (duration > STT_MAX_SECONDS) throw new STTError(413, 'audio_too_long', 'Record at most 30 seconds per turn.');
  if (duration < 0.2) throw new STTError(400, 'audio_too_short', 'Hold the microphone a little longer, then speak.');
  const samples = new Float32Array(data.length / 2);
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = data.readInt16LE(i * 2) / 32768;
    energy += samples[i] ** 2;
  }
  return { samples, duration, rms: Math.sqrt(energy / samples.length) };
}

export function createSTTEngine() {
  let worker;
  let initialization;
  let active = false;
  let sequence = 0;
  let state = { status: 'unloaded', progress: null, message: 'Whisper downloads once when you first use the microphone.', model: STT_MODEL_ID, device: 'cpu', dtype: 'q8', offline: false };
  const requests = new Map();
  const health = () => ({ ...state, busy: active });

  function failRequests(error) {
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  }

  function ensureWorker() {
    if (worker) return;
    // ONNX Runtime's native Node binding shares process-global V8 state and
    // crashes when Whisper and Kokoro use it from separate worker threads.
    // A process boundary isolates both Transformers env and the native addon.
    worker = fork(new URL('./stt-worker.mjs', import.meta.url), [], {
      windowsHide: true,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
    });
    const thisWorker = worker;
    worker.on('message', (event) => {
      if (worker !== thisWorker) return;
      if (event.type === 'health') {
        state = { ...state, ...event.state };
        return;
      }
      const request = requests.get(event.id);
      if (!request) return;
      requests.delete(event.id);
      if (event.error) request.reject(new STTError(event.error.status ?? 500, event.error.code ?? 'transcription_failed', event.error.message));
      else request.resolve(event.result);
    });
    worker.on('error', (error) => {
      if (worker !== thisWorker) return;
      state = { ...state, status: 'error', progress: null, message: 'The listening engine stopped. Try loading it again.' };
      failRequests(new STTError(503, 'stt_error', state.message));
      console.error('[stt] Process failed:', error.message);
    });
    worker.on('exit', () => {
      if (worker !== thisWorker) return;
      worker = undefined;
      initialization = undefined;
      if (state.status !== 'unloaded') state = { ...state, status: 'error', progress: null, message: 'The listening engine stopped. Try loading it again.' };
      failRequests(new STTError(503, 'stt_error', state.message));
    });
  }

  function request(type, payload = {}) {
    ensureWorker();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      worker.send({ id, type, ...payload }, (error) => {
        if (!error || !requests.has(id)) return;
        requests.delete(id);
        reject(new STTError(503, 'stt_error', 'The listening engine disconnected. Try loading it again.'));
      });
    });
  }

  function initialize() {
    if (state.status === 'ready') return Promise.resolve();
    if (initialization) return initialization;
    state = { ...state, status: 'loading', progress: 0, message: 'Preparing Whisper on CPU. The first download is about 80 MB.' };
    initialization = request('initialize').catch((error) => {
      initialization = undefined;
      state = { ...state, status: 'error', progress: null, message: error.message };
      throw error;
    });
    return initialization;
  }

  async function transcribe(input, { signal } = {}) {
    if (signal?.aborted) throw new STTError(499, 'cancelled', 'Listening was cancelled.');
    const decoded = decodeSTTWav(input);
    if (decoded.rms < 0.003) throw new STTError(422, 'no_speech', 'I did not hear speech. Move closer to the microphone and try again.');
    if (active) throw new STTError(429, 'stt_busy', 'Milo is still transcribing the previous recording. Try again in a moment.');
    active = true;
    const operation = (async () => {
      await initialize();
      if (signal?.aborted) throw new STTError(499, 'cancelled', 'Listening was cancelled.');
      const result = await request('transcribe', { samples: decoded.samples, duration: decoded.duration });
      if (!result.text?.trim()) throw new STTError(422, 'no_speech', 'I did not catch that. Try speaking a little closer to the microphone.');
      return result;
    })().finally(() => { active = false; });
    if (!signal) return operation;
    // Native ONNX inference cannot be safely interrupted mid-call. Reject the
    // caller now, discard its eventual text, and retain the CPU slot until done.
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new STTError(499, 'cancelled', 'Listening was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  async function dispose() {
    state = { ...state, status: 'unloaded', progress: null, message: 'The listening engine is stopped.' };
    if (worker) {
      const stopping = worker;
      await new Promise((resolve) => {
        stopping.once('exit', resolve);
        stopping.kill();
      });
    }
    worker = undefined;
    initialization = undefined;
  }
  return { health, initialize, transcribe, dispose };
}

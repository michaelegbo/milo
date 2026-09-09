import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSTTEngine, decodeSTTWav } from './stt-engine.mjs';
import { encodeWav, createSpeechEngine } from './engine.mjs';

const source = await readFile(new URL('./verification/cpu-speech.wav', import.meta.url));
assert.equal(source.readUInt32LE(24), 24000);
const original = new Float32Array((source.length - 44) / 2);
for (let i = 0; i < original.length; i++) original[i] = source.readInt16LE(44 + i * 2) / 32768;
const resampled = new Float32Array(Math.floor(original.length * 16000 / 24000));
for (let i = 0; i < resampled.length; i++) {
  const position = i * 1.5;
  const base = Math.floor(position);
  const alpha = position - base;
  resampled[i] = original[base] * (1 - alpha) + original[Math.min(base + 1, original.length - 1)] * alpha;
}
const wav = encodeWav(resampled, 16000);
await writeFile(new URL('./verification/microphone-fixture.wav', import.meta.url), wav);
assert.equal(decodeSTTWav(wav).duration, resampled.length / 16000);
assert.throws(() => decodeSTTWav(source), { code: 'invalid_audio' });
assert.throws(() => decodeSTTWav(Buffer.from('malformed')), { code: 'invalid_audio' });
assert.throws(() => decodeSTTWav(encodeWav(new Float32Array(16000 * 31), 16000)), { code: 'audio_too_long' });
const engine = createSTTEngine();
const speech = createSpeechEngine();
await speech.initialize();
assert.equal(speech.health().status, 'ready');
assert.equal(engine.health().status, 'unloaded');
await assert.rejects(engine.transcribe(encodeWav(new Float32Array(16000), 16000)), { code: 'no_speech' });
assert.equal(engine.health().status, 'unloaded', 'Silent recordings must not load the model.');
const timer = setInterval(() => console.log(JSON.stringify(engine.health())), 5000);
let report;
try {
  const start = performance.now();
  await engine.initialize();
  const initializationMs = Math.round(performance.now() - start);
  assert.equal(engine.health().device, 'cpu');
  assert.equal(engine.health().status, 'ready');
  const transcription = engine.transcribe(wav);
  await assert.rejects(engine.transcribe(wav), { code: 'stt_busy' });
  const result = await transcription;
  assert.match(result.text, /three[ -]dimensional avatar/i);
  assert.match(result.text, /voice is generated locally/i);
  assert.match(result.text, /CPU/i);
  const spokenAgain = await speech.generate({ text: 'I remember you said your favorite color is purple.', voice: 'af_heart', speed: 1 });
  assert(spokenAgain.wav.length > 48000, 'Kokoro must keep working after the native Whisper session runs.');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(engine.transcribe(wav, { signal: cancelled.signal }), { code: 'cancelled' });
  const duringInference = new AbortController();
  const abandoned = engine.transcribe(wav, { signal: duringInference.signal });
  setTimeout(() => duringInference.abort(), 100);
  await assert.rejects(abandoned, { code: 'cancelled' });
  while (engine.health().busy) await new Promise((resolve) => setTimeout(resolve, 100));
  report = { verifiedAt: new Date().toISOString(), model: engine.health().model, device: 'cpu', dtype: 'q8', isolation: 'child_process', initializationMs, ...result, invalidAudioRejected: true, silenceRejected: true, overlappingRequestsRejected: true, cancelledRequestsRejected: true, kokoroAfterWhisperVerified: true };
} finally {
  clearInterval(timer);
  await engine.dispose();
}
process.env.STT_OFFLINE = '1';
const offlineEngine = createSTTEngine();
try {
  const start = performance.now();
  await offlineEngine.initialize();
  const initializationMs = Math.round(performance.now() - start);
  const result = await offlineEngine.transcribe(wav);
  assert.match(result.text, /three[ -]dimensional avatar/i);
  report.offline = { verified: true, initializationMs, ...result };
} finally {
  await offlineEngine.dispose();
}
async function totalBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await totalBytes(child) : (await stat(child)).size;
  }
  return total;
}
report.modelCacheBytes = await totalBytes(fileURLToPath(new URL('./.cache/stt/', import.meta.url)));
await writeFile(new URL('./verification/stt-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.SPEECH_URL ?? 'http://127.0.0.1:8787';
const deadline = Date.now() + 5 * 60 * 1000;
let health;
do {
  health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.device, 'cpu');
  if (health.status === 'ready') break;
  if (health.status === 'error') throw new Error(health.message);
  console.log(`Engine ${health.status}: ${health.progress ?? 'preparing'}%`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
} while (Date.now() < deadline);
assert.equal(health.status, 'ready', 'Engine must finish loading before verifying speech.');

const payload = { text: 'Hello! I am your three dimensional avatar. My voice is generated locally, using only your CPU.', voice: 'af_heart', speed: 1 };
async function generate(body) {
  return fetch(`${base}/api/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
}
const response = await generate(payload);
assert.equal(response.status, 200, await response.clone().text());
assert.match(response.headers.get('content-type'), /audio\/wav/);
const wav = Buffer.from(await response.arrayBuffer());
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
assert.equal(wav.readUInt16LE(20), 1, 'WAV must contain PCM audio.');
assert.equal(wav.readUInt32LE(24), 24000, 'Expected 24 kHz audio.');
assert(wav.length > 48000, 'Speech must be longer than one second.');
let energy = 0;
for (let offset = 44; offset < wav.length; offset += 2) energy += wav.readInt16LE(offset) ** 2;
const rms = Math.sqrt(energy / ((wav.length - 44) / 2)) / 32768;
assert(rms > 0.001, 'Generated speech must contain a non-silent waveform.');
const verificationDir = new URL('./verification/', import.meta.url);
await mkdir(verificationDir, { recursive: true });
await writeFile(new URL('cpu-speech.wav', verificationDir), wav);

const cached = await generate(payload);
assert.equal(cached.status, 200);
assert.equal(cached.headers.get('x-audio-cached'), 'true');
assert.deepEqual(Buffer.from(await cached.arrayBuffer()), wav, 'Repeat speech should reuse the generated waveform.');
assert.equal((await generate({ ...payload, text: '' })).status, 400);
assert.equal((await generate({ ...payload, text: 'a'.repeat(601) })).status, 400);
assert.equal((await generate({ ...payload, voice: 'unknown' })).status, 400);
assert.equal((await generate({ ...payload, speed: 0 })).status, 400);
const numericOverflow = await generate({ ...payload, text: '1234567890 '.repeat(16).trim() });
assert.equal(numericOverflow.status, 400, 'Numeric phoneme expansion must not be silently truncated.');
assert.equal((await numericOverflow.json()).error, 'text_too_complex');
const acronymOverflow = await generate({ ...payload, text: 'WWW '.repeat(40).trim() });
assert.equal(acronymOverflow.status, 400, 'Spelled acronym expansion must not be silently truncated.');
assert.equal((await acronymOverflow.json()).error, 'text_too_complex');
const voicesVerified = [payload.voice];
for (const voice of ['am_michael', 'bf_emma']) {
  const otherVoice = await generate({ text: 'Hello there! It is lovely to meet you.', voice, speed: 1 });
  assert.equal(otherVoice.status, 200, `The ${voice} voice must synthesize successfully.`);
  const voiceWav = Buffer.from(await otherVoice.arrayBuffer());
  assert.equal(voiceWav.toString('ascii', 0, 4), 'RIFF');
  assert(voiceWav.length > 48000);
  voicesVerified.push(voice);
}
const oversized = await fetch(`${base}/api/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(9000) }) });
assert.equal(oversized.status, 413);
const malformed = await fetch(`${base}/api/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
assert.equal(malformed.status, 400);
const wrongContentType = await fetch(`${base}/api/speech`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'Hello' });
assert.equal(wrongContentType.status, 415);
const remoteOrigin = await fetch(`${base}/api/health`, { headers: { Origin: 'https://example.com' } });
assert.equal(remoteOrigin.status, 403);
const report = {
  verifiedAt: new Date().toISOString(),
  model: health.model,
  device: health.device,
  dtype: health.dtype,
  bytes: wav.length,
  durationSeconds: Number(response.headers.get('x-audio-duration')),
  generationMs: Number(response.headers.get('x-generation-ms')),
  servedFromCache: response.headers.get('x-audio-cached') === 'true',
  waveformRms: Number(rms.toFixed(5)),
  cacheVerified: true,
  voicesVerified,
  invalidRequestsRejected: true,
  phonemeOverflowRejected: true,
  oversizedBodyRejected: true,
  remoteOriginRejected: true,
  sample: fileURLToPath(new URL('cpu-speech.wav', verificationDir)),
};
await writeFile(new URL('report.json', verificationDir), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

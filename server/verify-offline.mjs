import assert from 'node:assert/strict';
import { writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createSpeechEngine, MODEL_CACHE_DIR, MODEL_ID } from './engine.mjs';

// Transformers uses fetch for remote files. For this isolated verification
// process, block it before importing the inference runtime so even an attempted
// download fails the test. This does not change networking for the running app.
let fetchAttempts = 0;
globalThis.fetch = async () => {
  fetchAttempts++;
  throw new Error('Network access is blocked by the offline verification.');
};
process.env.SPEECH_OFFLINE = '1';
const engine = createSpeechEngine();
await engine.initialize();
assert.equal(engine.health().status, 'ready', engine.health().message);
assert.equal(engine.health().offline, true);
const result = await engine.generate({ text: 'This voice was generated with network access disabled.', voice: 'bf_emma', speed: 1 });
assert.equal(result.wav.toString('ascii', 0, 4), 'RIFF');
assert(result.duration > 1);
await assert.rejects(engine.generate({ text: '1234567890 '.repeat(16).trim(), voice: 'af_heart', speed: 1 }), (error) => error.status === 400 && error.code === 'text_too_complex', 'Short numeric input that expands beyond the token limit must be rejected without silent truncation.');
await assert.rejects(engine.generate({ text: 'WWW '.repeat(40).trim(), voice: 'af_heart', speed: 1 }), (error) => error.status === 400 && error.code === 'text_too_complex', 'Spelled acronyms that expand beyond the token limit must be rejected without silent truncation.');
assert.equal(fetchAttempts, 0, 'No remote file request should be attempted from a complete local cache.');
const files = await Promise.all(['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map(async (file) => ({ path: join(MODEL_CACHE_DIR, MODEL_ID, file), bytes: (await stat(join(MODEL_CACHE_DIR, MODEL_ID, file))).size })));
const report = { verifiedAt: new Date().toISOString(), model: MODEL_ID, device: 'cpu', cacheDir: MODEL_CACHE_DIR, offline: true, fetchAttempts, phonemeOverflowRejected: true, numericAndAcronymInputsVerified: true, durationSeconds: result.duration, generationMs: result.generationMs, cacheFiles: files };
await mkdir(new URL('./verification/', import.meta.url), { recursive: true });
await writeFile(new URL('./verification/offline-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

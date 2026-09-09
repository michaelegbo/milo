import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CHAT_CACHE_DIR } from './chat-config.mjs';

async function verifyFile(path, profile) {
  try {
    if ((await stat(path)).size !== profile.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === profile.sha256;
  } catch { return false; }
}

export async function resolveChatModel(profile, update = () => {}) {
  await mkdir(CHAT_CACHE_DIR, { recursive: true });
  const target = join(CHAT_CACHE_DIR, profile.file);
  update({ status: 'loading', progress: 0, message: `Checking the local ${profile.label} conversation model.` });
  if (await verifyFile(target, profile)) return target;
  if (process.env.CHAT_OFFLINE === '1') throw new Error(`The ${profile.label} model is not cached. Start this profile once with internet before using CHAT_OFFLINE=1.`);
  const partial = `${target}.${randomUUID()}.partial`;
  const url = `https://huggingface.co/${profile.model}/resolve/${profile.revision}/${profile.file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Check your connection and try again.`);
  let downloaded = 0;
  let lastProgress = -1;
  const hash = createHash('sha256');
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      hash.update(chunk);
      const percentage = Math.min(95, Math.floor(downloaded / profile.bytes * 95));
      if (percentage !== lastProgress) {
        lastProgress = percentage;
        update({ status: 'loading', progress: percentage, message: `Downloading ${profile.label}: ${Math.round(downloaded / profile.bytes * 100)}% of ${(profile.bytes / 1e9).toFixed(2)} GB.` });
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: 'wx' }));
    if (downloaded !== profile.bytes || hash.digest('hex') !== profile.sha256) throw new Error('The model download failed integrity verification. Try again.');
    await rename(partial, target);
  } finally { await rm(partial, { force: true }); }
  return target;
}

// Pre-render the studio presets so they play instantly on the website.
// Hosted voice (default on the website): run `npm run dev:voice` with DEEPGRAM_API_KEY set, then
//   MILO_VOICE_URL=http://127.0.0.1:8792 node scripts/prepare-preset-audio.mjs
// On-device voice: start `npm run dev:speech`, then run without MILO_VOICE_URL (needs ffmpeg on PATH).
// Output: public/presets/<n>-<voice>.mp3, committed with the site.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { presets, PRESET_VOICES, presetClipPath } from '../src/presets.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const speechUrl = process.env.MILO_SPEECH_URL || 'http://127.0.0.1:8787';
const voiceUrl = process.env.MILO_VOICE_URL || '';
const output = join(root, 'public');
await mkdir(join(output, 'presets'), { recursive: true });

for (const [index, preset] of presets.entries()) {
  for (const voice of PRESET_VOICES) {
    const mp3 = join(output, presetClipPath(index, voice).slice(1));
    if (voiceUrl) {
      const response = await fetch(`${voiceUrl}/api/voice/speak?format=mp3`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: preset.text, voice }) });
      if (!response.ok) throw new Error(`Voice proxy returned ${response.status} for preset ${index + 1} (${voice}).`);
      await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
      console.log(`Rendered ${presetClipPath(index, voice)} with the hosted voice`);
      continue;
    }
    const response = await fetch(`${speechUrl}/api/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ text: preset.text, voice, speed: 1 }),
    });
    if (!response.ok) throw new Error(`Speech server returned ${response.status} for preset ${index + 1} (${voice}).`);
    const wav = join(output, 'presets', `${index + 1}-${voice}.wav`);
    await writeFile(wav, Buffer.from(await response.arrayBuffer()));
    // Mono 24 kHz MP3 decodes in every browser's decodeAudioData and stays small.
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1', mp3]);
    await rm(wav);
    console.log(`Rendered ${presetClipPath(index, voice)}`);
  }
}

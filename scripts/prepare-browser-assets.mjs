import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const copies = [
  ...['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'].map(name => [`node_modules/onnxruntime-web/dist/${name}`, `public/runtime/ort/${name}`]),
  ...['af_heart', 'am_michael', 'bf_emma'].map(name => [`node_modules/kokoro-js/voices/${name}.bin`, `public/runtime/voices/${name}.bin`]),
];
for (const [source, destination] of copies) {
  const target = join(root, destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, source), target);
}
console.log(`Prepared ${copies.length} browser audio runtime assets.`);

// Preserve the notices shipped with the browser libraries and fonts. These
// components retain their own licenses rather than Milo's noncommercial terms.
const browserPackages = ['three', 'kokoro-js', 'phonemizer', '@huggingface/transformers', 'onnxruntime-web', 'onnxruntime-common', '@wllama/wllama', '@wllama/wllama-compat', '@fontsource-variable/dm-sans', '@fontsource-variable/manrope'];
const notices = ['# Third-party notices', '', 'Milo original code is licensed separately. The libraries, runtime files, voices and fonts below retain their upstream terms. Model weights have separate model-card and license terms; see the project README.', ''];
for (const name of browserPackages) {
  const directory = join(root, 'node_modules', name);
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  notices.push(`## ${name} ${metadata.version}`, '', `Declared license: ${metadata.license ?? 'See upstream'}`, '', `Source: ${metadata.homepage ?? metadata.repository?.url ?? ''}`, '');
  for (const file of (await readdir(directory)).filter(file => /^(LICENSE|LICENCE|NOTICE|COPYING)(\.|$)/i.test(file))) {
    notices.push(`### ${file}`, '', await readFile(join(directory, file), 'utf8'), '');
  }
}
await writeFile(join(root, 'public/runtime/THIRD-PARTY-NOTICES.txt'), notices.join('\n'));

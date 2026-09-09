import { DEVICE_CHAT_MODELS } from './chat-models';

export const AUDIO_FILES = {
  tts: { model: 'onnx-community/Kokoro-82M-v1.0-ONNX', files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'] },
  stt: { model: 'Xenova/whisper-base.en', files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'] },
};
export function audioFileUrl(model: string, file: string) {
  const base = import.meta.env.VITE_AUDIO_MODEL_BASE;
  return base ? new URL(`${model}/${file}`, new URL(base.replace(/\/?$/, '/'), location.origin)).href : `https://huggingface.co/${model}/resolve/main/${file}`;
}
export type SavedEngine = { ready: boolean; found: number; total: number; bytes: number };
export type SavedDownloads = Record<'tts' | 'stt' | 'fast' | 'quality', SavedEngine>;
export function shardUrls(url: string) {
  const absolute = new URL(url, location.origin).href;
  const match = absolute.match(/-00001-of-(\d{5})\.gguf$/);
  return match ? Array.from({ length: Number(match[1]) }, (_, i) => absolute.replace('-00001-of-', `-${String(i + 1).padStart(5, '0')}-of-`)) : [absolute];
}
export async function chatCacheKey(url: string) {
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url));
  return `${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}_${url.split('/').pop()}`;
}
/** Read actual cache entries, never a remembered downloaded flag. No network or model loading. */
export async function inspectSavedDownloads(): Promise<SavedDownloads> {
  const result = {} as SavedDownloads;
  const cache = 'caches' in globalThis && (await caches.keys()).includes('transformers-cache') ? await caches.open('transformers-cache') : undefined;
  for (const kind of ['tts', 'stt'] as const) {
    const { model, files } = AUDIO_FILES[kind];
    let found = 0, bytes = 0;
    for (const file of files) {
      const response = await cache?.match(audioFileUrl(model, file));
      // Cache API writes are atomic. Do not read multi-megabyte bodies merely to list them.
      if (response?.ok) { found++; bytes += Number(response.headers.get('content-length')) || 0; }
    }
    result[kind] = { ready: found === files.length, found, total: files.length, bytes };
  }
  let directory: FileSystemDirectoryHandle | undefined;
  if (navigator.storage?.getDirectory) {
    try { directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('cache'); }
    catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
  }
  for (const kind of ['fast', 'quality'] as const) {
    const urls = shardUrls(DEVICE_CHAT_MODELS[kind].url);
    let found = 0, bytes = 0, complete = 0;
    for (const url of urls) {
      if (!directory) break;
      const key = await chatCacheKey(url);
      try {
        const file = await (await directory.getFileHandle(key)).getFile();
        found++; bytes += file.size;
        const meta = JSON.parse(await (await (await directory.getFileHandle(`__metadata__${key}`)).getFile()).text());
        if (file.size >= 16 && meta.originalURL === url && meta.originalSize === file.size) complete++;
      } catch (error) { if (!(error instanceof SyntaxError) && (error as DOMException).name !== 'NotFoundError') throw error; }
    }
    result[kind] = { ready: complete === urls.length, found, total: urls.length, bytes };
  }
  return result;
}

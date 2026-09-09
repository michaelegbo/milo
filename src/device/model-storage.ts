import { DEVICE_CHAT_MODELS } from './chat-models';

export const MODEL_STORAGE_LOCK = 'milo-model-storage';
const audioModels = ['onnx-community/Kokoro-82M-v1.0-ONNX', 'Xenova/whisper-base.en'];
type Entry = { bytes: number; remove: () => Promise<unknown> };

// Match the pinned wllama 3.6 cache keys, including partially downloaded files
// without metadata. Never remove the whole origin filesystem or cache bucket.
async function chatKeys() {
  const urls = Object.values(DEVICE_CHAT_MODELS).flatMap(model => {
    const url = new URL(model.url, document.baseURI).href;
    const shard = url.match(/-00001-of-(\d{5})\.gguf$/);
    return shard ? Array.from({ length: Number(shard[1]) }, (_, i) => url.replace('-00001-of-', `-${String(i + 1).padStart(5, '0')}-of-`)) : [url];
  });
  urls.push(new URL('/models/chat/quality.gguf', document.baseURI).href);
  const names = await Promise.all(urls.map(async url => {
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url));
    return `${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}_${url.split('/').pop()}`;
  }));
  return new Set(names.flatMap(name => [name, `__metadata__${name}`]));
}

async function entries(): Promise<Entry[]> {
  const found: Entry[] = [];
  const host = new URL(import.meta.env.VITE_AUDIO_MODEL_BASE || '/models/', location.origin).href.replace(/\/?$/, '/');
  const prefixes = audioModels.flatMap(model => [new URL(`${model}/`, host).href, `https://huggingface.co/${model}/resolve/`]);
  if ('caches' in globalThis && (await caches.keys()).includes('transformers-cache')) {
    const cache = await caches.open('transformers-cache');
    for (const request of await cache.keys()) {
      if (!prefixes.some(prefix => request.url.startsWith(prefix))) continue;
      const response = await cache.match(request);
      found.push({ bytes: Number(response?.headers.get('content-length')) || 0, remove: () => cache.delete(request) });
    }
  }
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    let directory: FileSystemDirectoryHandle;
    try { directory = await root.getDirectoryHandle('cache'); }
    catch (error) { if ((error as DOMException).name === 'NotFoundError') return found; throw error; }
    const keys = await chatKeys();
    for (const name of keys) {
      try {
        const file = await (await directory.getFileHandle(name)).getFile();
        found.push({ bytes: file.size, remove: async () => {
          try { await directory.removeEntry(name); }
          catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
        } });
      } catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
    }
  }
  return found;
}

export async function storedModels() {
  const files = await entries();
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/** Caller must stop this tab's engines before requesting exclusive access. */
export async function clearStoredModels() {
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate deletion. Close Milo tabs and clear this site’s data in browser settings.');
  return navigator.locks.request(MODEL_STORAGE_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another Milo tab is using the models. Close it or choose Free up memory there, then try again.');
    // Also respect model downloads in tabs opened before storage leases existed.
    return navigator.locks.request('milo-chat-model-cache', { ifAvailable: true }, async cacheLock => {
      if (!cacheLock) throw new Error('Another Milo tab is downloading a model. Close it, then try again.');
      const files = await entries();
      for (const file of files) await file.remove();
      if ((await entries()).length) throw new Error('Some model files are still present. Close other Milo tabs and try again.');
      return files.length;
    });
  });
}

export function holdModelStorage(signal: AbortSignal): Promise<() => Promise<void>> {
  if (!navigator.locks) return Promise.resolve(async () => {});
  return new Promise((resolve, reject) => {
    let release: () => void;
    const released = new Promise<void>(done => { release = done; });
    const request = navigator.locks.request(MODEL_STORAGE_LOCK, { mode: 'shared', signal }, async () => {
      resolve(async () => { release(); await request; });
      await released;
    });
    void request.catch(reject);
  });
}

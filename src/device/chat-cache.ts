import { Model, ModelValidationStatus, ModelManager, type DownloadOptions } from '@wllama/wllama/esm/index.js';

/** An incomplete unrelated model must not prevent a complete model from reopening. */
export async function reopenOrDownload(manager: ModelManager, url: string, options: DownloadOptions = {}, expectedBytes = 0) {
  const files = await manager.cacheManager.list();
  let saved: Model | undefined;
  try { saved = new Model(manager, url, undefined, files); } catch { /* Missing shards: repair this model only. */ }
  if (saved?.validate() === ModelValidationStatus.VALID) {
    options.progressCallback?.({ loaded: saved.size, total: saved.size });
    return saved;
  }
  if (expectedBytes && navigator.storage?.estimate) {
    const urls = new Set(ModelManager.parseModelUrl(url));
    const reusable = files.filter(file => urls.has(file.metadata.originalURL) && file.size === file.metadata.originalSize).reduce((sum, file) => sum + file.size, 0);
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.quota - (estimate.usage ?? 0) < Math.max(0, expectedBytes - reusable) * 1.05) throw new Error('There is not enough browser storage for the missing reply files. Free some storage or choose Fast.');
  }
  // The pinned CacheManager reuses complete shards and replaces only incomplete files.
  return manager.downloadModel(url, options);
}

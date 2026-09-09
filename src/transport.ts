import { isDeviceOnly } from './deployment';

/** Keep local Node development unchanged; public inference is always in this tab. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (isDeviceOnly) return (await import('./device/transport')).deviceRequest(path, init);
  return fetch(path, init);
}

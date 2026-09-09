import type { DeviceProfile } from './transport';

/**
 * Local reply models live entirely inside one browser tab. A phone kills that
 * tab long before the model finishes loading, which the visitor sees as a page
 * crash, so the choice is made before a single byte is downloaded or loaded.
 *
 * iPhone and iPad never report their memory, and Safari's engine (which every
 * iOS browser uses) caps a tab well under what Qwen 4B needs. Android and
 * desktop Chrome report deviceMemory, rounded and capped at 8 GB.
 */
export type DeviceBudget = {
  ios: boolean; android: boolean; mobile: boolean; memoryGB: number | null;
  allows(profile: DeviceProfile): boolean;
  reason(profile: DeviceProfile): string;
};

const NEEDS_GB = { fast: 4, quality: 8 } as const;

export function deviceBudget(nav: Navigator = navigator): DeviceBudget {
  const ua = nav.userAgent || '';
  const ios = /iPhone|iPad|iPod/i.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const memoryGB = typeof (nav as Navigator & { deviceMemory?: number }).deviceMemory === 'number' ? (nav as Navigator & { deviceMemory?: number }).deviceMemory! : null;
  const allows = (profile: DeviceProfile) => {
    if (profile === 'fast') return memoryGB === null || memoryGB >= NEEDS_GB.fast;
    if (ios) return false;
    if (memoryGB !== null) return memoryGB >= NEEDS_GB.quality;
    return !android; // Unknown memory on Android: assume a phone.
  };
  const reason = (profile: DeviceProfile) => {
    if (profile === 'fast') return `Fast needs about ${NEEDS_GB.fast} GB of device memory and this device reports ${memoryGB} GB, so it would run out while loading. Use ChatGPT replies instead.`;
    if (ios) return 'Better answers needs about 3 GB inside one browser tab, more than iPhone and iPad allow, so the page would crash while loading. Use Fast here, or ChatGPT replies.';
    return `Better answers needs about ${NEEDS_GB.quality} GB of device memory${memoryGB !== null ? ` and this device reports ${memoryGB} GB` : ''}, so the page would run out while loading. Use Fast here, or ChatGPT replies.`;
  };
  return { ios, android, mobile: ios || android, memoryGB, allows, reason };
}

type Adapter = {
  features: { has(name: string): boolean };
  isFallbackAdapter?: boolean;
  info?: { vendor?: string; architecture?: string; description?: string };
};

/** Use only identity exposed by WebGPU; a WebGL renderer may be a different GPU. */
export function describeGpuAdapter(adapter?: Adapter | null) {
  const info = adapter?.info;
  const description = info?.description?.trim();
  const vendor = info?.vendor?.trim();
  const software = /swiftshader|llvmpipe|software|lavapipe/i.test([vendor, info?.architecture, description].join(' '));
  const available = !!adapter && !adapter.isFallbackAdapter && adapter.features.has('shader-f16') && !software;
  if (!available) return { available: false, deviceName: null, deviceInfo: null };
  const vendors: Record<string, string> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', arm: 'ARM', qualcomm: 'Qualcomm' };
  const brand = vendor ? vendors[vendor.toLowerCase()] ?? vendor : null;
  return {
    available: true,
    deviceName: `${description || (brand ? `${brand} GPU` : 'Compatible GPU')} · WebGPU`,
    deviceInfo: description ? null : 'Your browser hides the exact GPU model name.',
  };
}

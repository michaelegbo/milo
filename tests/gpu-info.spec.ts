import { test, expect } from '@playwright/test';
import { describeGpuAdapter } from '../src/device/gpu-info';

const features = new Set(['shader-f16']);
test('reports an exposed model without borrowing another rendering adapter identity', () => {
  expect(describeGpuAdapter({ features, info: { vendor: 'nvidia', description: 'NVIDIA GeForce RTX 4090' } })).toEqual({
    available: true, deviceName: 'NVIDIA GeForce RTX 4090 · WebGPU', deviceInfo: null,
  });
});
test('handles privacy-redacted model names and entirely redacted identities honestly', () => {
  expect(describeGpuAdapter({ features, info: { vendor: 'nvidia', architecture: 'lovelace', description: '' } })).toEqual({
    available: true, deviceName: 'NVIDIA GPU · WebGPU', deviceInfo: 'Your browser hides the exact GPU model name.',
  });
  expect(describeGpuAdapter({ features })).toMatchObject({ available: true, deviceName: 'Compatible GPU · WebGPU' });
});
test('does not label software adapters or unsupported devices as hardware acceleration', () => {
  for (const adapter of [null, { features: new Set() }, { features, isFallbackAdapter: true }, { features, info: { vendor: 'Google', architecture: 'swiftshader' } }]) {
    expect(describeGpuAdapter(adapter)).toEqual({ available: false, deviceName: null, deviceInfo: null });
  }
});

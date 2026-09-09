import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';

async function setup(page: Page) {
  const source = await readFile(new URL('../src/device/audio-client.ts', import.meta.url), 'utf8');
  const compiled = (await transformWithOxc(source, 'audio-client.ts', { target: 'es2022' })).code;
  await page.route('**/src/device/audio-client.ts', route => route.fulfill({ contentType: 'text/javascript', body: compiled }));
  await page.route('**/__device_audio_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Device audio lifecycle</title>' }));
  await page.goto('/__device_audio_test');
  await page.evaluate(() => {
    const state = { workers: [] as any[], hold: false, failInit: false };
    (window as any).__audioTest = state;
    class FakeWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror?: (event: unknown) => void;
      onmessageerror?: (event: unknown) => void;
      terminated = false;
      calls: any[] = [];
      constructor(_url: URL, public options: WorkerOptions) { state.workers.push(this); }
      emit(data: unknown) { this.onmessage?.({ data }); }
      postMessage(message: any) {
        this.calls.push(message);
        if (message.type === 'generate' && state.hold) return;
        queueMicrotask(() => {
          if (message.type === 'initialize') {
            if (state.failInit) {
              this.emit({ health: { status: 'error', message: 'Test startup failure' } });
              this.emit({ id: message.id, error: 'Test startup failure' }); return;
            }
            this.emit({ health: { status: 'loading', progress: 50 } });
            this.emit({ health: { status: 'ready', progress: 100, offline: true } });
            this.emit({ id: message.id, result: true });
          } else if (message.type === 'generate') this.emit({ id: message.id, result: { wav: new ArrayBuffer(48), duration: 1, generationMs: 10, cached: false } });
        });
      }
      terminate() { this.terminated = true; }
    }
    (window as any).Worker = FakeWorker;
  });
}

test('device audio is lazy, validates before download, and returns local WAV metadata', async ({ page }) => {
  await setup(page);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  const result = await page.evaluate(async () => {
    const source = '/src/device/audio-client.ts';
    const { DeviceAudioClient } = await import(source);
    const client = new DeviceAudioClient();
    const before = (window as any).__audioTest.workers.length;
    let invalid = false;
    try { await client.generate({ text: '' }); } catch { invalid = true; }
    const afterInvalid = (window as any).__audioTest.workers.length;
    const generated = await client.generate({ text: 'Hello.' });
    const health = client.health();
    client.dispose();
    return { before, invalid, afterInvalid, bytes: generated.wav.size, type: generated.wav.type, duration: generated.duration, health };
  });
  expect(result.before).toBe(0);
  expect(result.invalid).toBe(true);
  expect(result.afterInvalid).toBe(0);
  expect(result.bytes).toBe(48);
  expect(result.type).toBe('audio/wav');
  expect(result.health.tts.status).toBe('ready');
  expect(result.health.stt.status).toBe('unloaded');
  expect(requests.some(url => url.includes('/api/'))).toBe(false);
});

test('cancelling voice terminates only its worker and ignores stale completion', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const source = '/src/device/audio-client.ts';
    const { DeviceAudioClient } = await import(source);
    const client = new DeviceAudioClient();
    await client.initialize('both');
    const testState = (window as any).__audioTest;
    testState.hold = true;
    const abort = new AbortController();
    const pending = client.generate({ text: 'This will stop.' }, { signal: abort.signal }).then(() => 'unexpected', (error: Error) => error.name);
    while (!testState.workers[0].calls.some((call: any) => call.type === 'generate')) await new Promise(resolve => setTimeout(resolve, 0));
    const old = testState.workers[0];
    const oldId = old.calls.at(-1).id;
    abort.abort();
    const cancellation = await pending;
    const stopped = client.health();
    testState.hold = false;
    await client.initialize('tts');
    old.emit({ health: { status: 'error', message: 'A stale worker must not replace current health.' } });
    old.emit({ id: oldId, result: { wav: new ArrayBuffer(48) } });
    const recovered = client.health();
    const workers = testState.workers.map((worker: any) => ({ name: worker.options.name, terminated: worker.terminated }));
    client.dispose();
    return { cancellation, stopped, recovered, workers };
  });
  expect(result.cancellation).toBe('AbortError');
  expect(result.stopped.tts.status).toBe('unloaded');
  expect(result.stopped.stt.status).toBe('ready');
  expect(result.workers[0].terminated).toBe(true);
  expect(result.workers[1].terminated).toBe(false);
  expect(result.recovered.tts.status).toBe('ready');
  expect(result.workers).toHaveLength(3);
});

test('failed initialization releases its partial worker and retries without a server fallback', async ({ page }) => {
  await setup(page);
  const api: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) api.push(request.url()); });
  const result = await page.evaluate(async () => {
    const source = '/src/device/audio-client.ts';
    const { DeviceAudioClient } = await import(source);
    const client = new DeviceAudioClient();
    const testState = (window as any).__audioTest;
    testState.failInit = true;
    const message = await client.initialize('tts').then(() => '', (error: Error) => error.message);
    const failed = client.health();
    const terminated = testState.workers[0].terminated;
    testState.failInit = false;
    await client.initialize('tts');
    const recovered = client.health();
    client.dispose();
    return { message, failed, terminated, recovered };
  });
  expect(result.message).toContain('startup failure');
  expect(result.failed.tts.status).toBe('error');
  expect(result.terminated).toBe(true);
  expect(result.recovered.tts.status).toBe('ready');
  expect(api).toEqual([]);
});

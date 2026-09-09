import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Run against a Vite instance started with VITE_MILO_DEVICE_ONLY=1.
// The clients are mocked; the real transport, consent UI, transcript and audio graph run.
test.use({ baseURL: process.env.MILO_DEVICE_TEST_URL || 'http://127.0.0.1:5175' });
test.skip(!process.env.MILO_DEVICE_TEST_URL, 'Set MILO_DEVICE_TEST_URL for the separate device-only UI suite.');

async function setup(page: Page, unsupported = false) {
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  const source = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  const wav = Buffer.from(source.subarray(0, 44 + 16000 * 2));
  wav.writeUInt32LE(wav.length - 8, 4); wav.writeUInt32LE(wav.length - 44, 40);
  await page.addInitScript(({ audio, unsupported }) => {
    const state = (window as any).__device = {
      initialize: [] as string[], turns: [] as any[], speech: [] as string[], transcriptions: 0,
      micCalls: 0, starts: 0, stops: 0, disposed: 0,
      holdInitialize: false, holdReply: false, holdGpu: false, gpuAvailable: false, switches: [] as boolean[], initializeError: '', replyError: '',
      releaseInitialize: undefined as undefined | (() => void), releaseReply: undefined as undefined | (() => void),
      releaseGpu: undefined as undefined | (() => void),
      replyText: 'Hello, lovely to meet you.',
    };
    if (unsupported) Object.defineProperty(window, 'crossOriginIsolated', { value: false });
    navigator.mediaDevices.getUserMedia = async () => { state.micCalls++; throw new DOMException('These tests never open the physical mic.', 'NotAllowedError'); };
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) { state.starts++; return start.apply(this, args); };
    AudioBufferSourceNode.prototype.stop = function (...args) { state.stops++; return stop.apply(this, args); };
    const initial = () => ({ status: 'unloaded', progress: 0, message: 'Not loaded', device: 'cpu', queueDepth: 0 });
    const health = { tts: initial(), stt: initial(), chat: { ...initial(), profile: 'fast', selectedModel: 'fast', acceleration: { available: false, enabled: false, status: 'unavailable', backend: null as string | null, deviceName: null as string | null, revision: 0, message: 'CPU ready.' } } };
    const gate = (kind: 'Initialize' | 'Reply' | 'Gpu', signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('Stopped', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      if (state[`hold${kind}`]) state[`release${kind}`] = finish;
      else setTimeout(finish, 150);
    });
    (window as any).__audioClient = {
      health: () => ({ tts: { ...health.tts }, stt: { ...health.stt } }),
      initialize: async (kind: string, { signal }: { signal?: AbortSignal } = {}) => {
        state.initialize.push(`audio:${kind}`);
        const kinds = kind === 'both' ? ['tts', 'stt'] : [kind];
        for (const key of kinds) Object.assign((health as any)[key], { status: 'loading', progress: 35 });
        await gate('Initialize', signal); signal?.throwIfAborted();
        if (state.initializeError) { Object.assign(health.tts, { status: 'error', message: state.initializeError }); throw new Error(state.initializeError); }
        for (const key of kinds) Object.assign((health as any)[key], { status: 'ready', progress: 100 });
      },
      generate: async ({ text }: { text: string }, { signal }: { signal?: AbortSignal } = {}) => {
        signal?.throwIfAborted(); state.speech.push(text);
        const bytes = Uint8Array.from(atob(audio), value => value.charCodeAt(0));
        return { wav: new Blob([bytes], { type: 'audio/wav' }), duration: 1, generationMs: 30, cached: false };
      },
      transcribe: async () => { state.transcriptions++; return { text: 'Hello from my device.', duration: 1, transcriptionMs: 20 }; },
      dispose: () => { health.tts = initial(); health.stt = initial(); state.disposed++; },
    };
    (window as any).__chatClient = {
      health: () => ({ ...health.chat, acceleration: { ...health.chat.acceleration, available: state.gpuAvailable, backend: state.gpuAvailable ? 'webgpu' : null, deviceName: state.gpuAvailable ? 'NVIDIA GPU · WebGPU' : null, deviceInfo: state.gpuAvailable ? 'Your browser hides the exact GPU model name.' : null } }),
      initialize: async ({ profile, signal }: any) => {
        state.initialize.push(`chat:${profile}`); Object.assign(health.chat, { status: 'loading', progress: 45, profile });
        await gate('Initialize', signal); signal?.throwIfAborted();
        Object.assign(health.chat, { status: 'ready', progress: 100, profile });
      },
      reply: async (messages: any[], options: any) => {
        state.turns.push({ messages: structuredClone(messages), memory: structuredClone(options.memory), profile: options.profile });
        const text = state.replyText;
        const profile = options.profile === 'hybrid' ? /explain|compare/i.test(messages.at(-1).content) ? 'quality' : 'fast' : options.profile;
        options.onRouting({ profile, reason: profile === 'fast' ? 'A simple turn.' : 'This benefits from careful thought.' });
        await gate('Reply', options.signal); options.signal?.throwIfAborted();
        if (state.replyError) throw new Error(state.replyError);
        options.onTextChunk(text);
        return { text, profile, mode: options.profile, device: 'cpu', generationMs: 100 };
      },
      summarize: async () => ({ summary: 'A conversation on this device.' }),
      setAcceleration: async (enabled: boolean, { signal }: { signal?: AbortSignal } = {}) => {
        state.switches.push(enabled);
        health.chat.acceleration.status = 'switching'; health.chat.status = 'loading';
        const revision = ++health.chat.acceleration.revision;
        await gate('Gpu', signal); signal?.throwIfAborted();
        if (health.chat.acceleration.revision !== revision) throw new DOMException('Superseded', 'AbortError');
        health.chat.device = enabled ? 'gpu' : 'cpu'; health.chat.status = 'ready';
        Object.assign(health.chat.acceleration, { enabled, status: 'ready', message: enabled ? 'Replies use this device’s GPU.' : 'GPU memory released. Replies use this device’s CPU.' });
      },
      dispose: () => { Object.assign(health.chat, initial()); state.disposed++; },
    };
  }, { audio: wav.toString('base64'), unsupported });
  await page.route('**/src/device/audio-client.ts*', route => route.fulfill({ contentType: 'text/javascript', body: 'export const deviceAudio = window.__audioClient;' }));
  await page.route('**/src/device/chat-client.ts*', route => route.fulfill({ contentType: 'text/javascript', body: 'export const deviceChat = window.__chatClient;' }));
  await page.route('**/', async route => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } });
  });
  await page.goto('/');
  await expect(page.locator('#device-setup')).toBeVisible();
  return { requests, errors };
}

function expectPrivate(requests: string[]) {
  expect(requests.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
}

async function enableConversation(page: Page) {
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.getByRole('button', { name: /Download & start conversation/ }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message Milo' }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
}

test('device landing requests no models or API before consent and plays local speech at desktop and mobile sizes', async ({ page }, testInfo) => {
  const { requests, errors } = await setup(page);
  await expect(page.locator('.device-privacy')).toContainText('stay in this browser');
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'View source' })).toHaveAttribute('href', 'https://github.com/michaelegbo/milo');
  await page.waitForTimeout(800);
  expect(requests.filter(url => /audio-client|chat-client|\.gguf|\.onnx|\.wasm/.test(url))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__device.initialize)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('device-desktop-consent.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('device-mobile-consent.png'), fullPage: true });
  await page.getByRole('button', { name: /Download & start voice/ }).click();
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__device.initialize)).toEqual(['audio:tts']);
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__device.starts)).toBe(1);
  await expect(page.locator('#speech-status')).toContainText('That’s a wrap');
  await page.getByRole('button', { name: 'Free up memory' }).click();
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__device.micCalls)).toBe(0);
  expectPrivate(requests); expect(errors).toEqual([]);
});

test('each conversation profile requires consent, retains memory and streams Hybrid replies entirely on the device', async ({ page }, testInfo) => {
  const { requests, errors } = await setup(page);
  await enableConversation(page);
  await expect(page.getByRole('switch', { name: 'GPU acceleration' })).toBeHidden();
  await send(page, 'My name is Amara.');
  await page.getByLabel('MILO’S MIND').selectOption('hybrid');
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await expect(page.locator('#device-download-size')).toContainText('up to 3.8 GB');
  expect(await page.evaluate(() => (window as any).__device.initialize)).toEqual(['audio:both', 'chat:fast']);
  await page.getByRole('button', { name: /Download & start conversation/ }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await send(page, 'Explain why leaves are green.');
  await expect(page.locator('#route-label')).toHaveText('Considered reply');
  const turns = await page.evaluate(() => (window as any).__device.turns);
  expect(turns[1].profile).toBe('hybrid');
  expect(turns[1].memory.facts.join(' ')).toContain('Amara');
  expect(turns[1].messages[0].content).toBe('My name is Amara.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('device-mobile-conversation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Free up memory' }).click();
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await expect(page.locator('.conversation-message.user').first()).toContainText('Amara');
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  expect(await page.evaluate(() => (window as any).__device.micCalls)).toBe(0);
  expectPrivate(requests); expect(errors).toEqual([]);
});

test('an unsupported browser fails closed with a useful explanation and no model or inference requests', async ({ page }) => {
  const { requests, errors } = await setup(page, true);
  await expect(page.locator('#device-status')).toContainText('cannot start local AI');
  await expect(page.locator('#device-start')).toBeDisabled();
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('This must never leave the device.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__device.initialize)).toEqual([]);
  expectPrivate(requests); expect(errors).toEqual([]);
});

test('download cancellation releases engines, errors remain local and explicit retry recovers', async ({ page }) => {
  const { requests, errors } = await setup(page);
  await page.evaluate(() => { (window as any).__device.holdInitialize = true; });
  await page.getByRole('button', { name: /Download & start voice/ }).click();
  await expect(page.getByRole('button', { name: 'Cancel download' })).toBeVisible();
  await expect(page.locator('#device-progress')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel download' }).click();
  await expect(page.locator('#device-status')).toContainText('Models stopped');
  await expect(page.locator('#device-start')).toBeEnabled();
  await page.evaluate(() => { const state = (window as any).__device; state.holdInitialize = false; state.initializeError = 'Not enough memory on this device. Close other tabs and try again.'; });
  await page.locator('#device-start').click();
  await expect(page.locator('#device-status')).toContainText('Not enough memory');
  await expect(page.getByRole('button', { name: 'Try loading again' })).toBeEnabled();
  await page.evaluate(() => { (window as any).__device.initializeError = ''; });
  await page.getByRole('button', { name: 'Try loading again' }).click();
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  expectPrivate(requests); expect(errors).toEqual([]);
});

test('unloading during a pending reply cancels stale text and audio while preserving this tab’s history', async ({ page }) => {
  const { requests, errors } = await setup(page);
  await enableConversation(page);
  await send(page, 'My name is Amara.');
  const previousSpeech = await page.evaluate(() => (window as any).__device.speech.length);
  await page.evaluate(() => { const state = (window as any).__device; state.holdReply = true; state.replyText = 'This late reply must never appear.'; });
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Tell me a story.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__device.turns.length)).toBe(2);
  await page.getByRole('button', { name: 'Free up memory' }).click();
  await page.evaluate(() => { (window as any).__device.releaseReply?.(); });
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(1);
  await expect(page.locator('.conversation-message.user').first()).toContainText('Amara');
  expect(await page.evaluate(() => (window as any).__device.speech.length)).toBe(previousSpeech);
  expectPrivate(requests); expect(errors).toEqual([]);
});

test('browser GPU can return to CPU while warming or answering without losing Hybrid memory or using an API', async ({ page }, testInfo) => {
  const { requests, errors } = await setup(page);
  await page.evaluate(() => { (window as any).__device.gpuAvailable = true; });
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.getByLabel('MILO’S MIND').selectOption('hybrid');
  await page.getByRole('button', { name: /Download & start conversation/ }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await send(page, 'My name is Amara.');
  const gpu = page.getByRole('switch', { name: 'GPU acceleration' });
  await expect(gpu).toBeVisible();
  await page.evaluate(() => { (window as any).__device.holdGpu = true; });
  await gpu.click();
  await expect(gpu).toHaveAttribute('aria-checked', 'true');
  await expect(gpu).toBeEnabled();
  await expect(page.locator('#gpu-status')).toContainText('Switching');
  await page.evaluate(() => { (window as any).__device.holdGpu = false; });
  await gpu.click();
  await expect(gpu).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('#gpu-status')).toContainText('CPU');
  await gpu.click();
  await expect(page.locator('#gpu-status')).toHaveText('GPU active');
  await expect(page.locator('#gpu-device')).toHaveText('NVIDIA GPU · WebGPU');
  await expect(page.locator('#gpu-details')).toBeVisible();
  await expect(page.locator('#gpu-details')).toHaveText('Your browser hides the exact GPU model name.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('device-mobile-gpu.png'), fullPage: true });
  const previousSpeech = await page.evaluate(() => (window as any).__device.speech.length);
  await page.evaluate(() => { const state = (window as any).__device; state.holdReply = true; state.replyText = 'This GPU reply was cancelled.'; });
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Explain why leaves are green.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__device.turns.length)).toBe(2);
  await gpu.click();
  await expect(page.locator('#gpu-status')).toContainText('CPU');
  await page.evaluate(() => { (window as any).__device.releaseReply?.(); });
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__device.speech.length)).toBe(previousSpeech);
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await expect(page.locator('#memory-detail')).toContainText('Amara');
  expect(await page.evaluate(() => (window as any).__device.switches)).toEqual([true, false, true, false]);
  expectPrivate(requests); expect(errors).toEqual([]);
});

test('the real unloaded device page displays consent before any model request at desktop and phone widths', async ({ page }, testInfo) => {
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  // No routes, fake workers, fake inference, or capability overrides in this test.
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-deployment', 'device');
  await expect(page.locator('#device-start')).toBeEnabled();
  await expect(page.locator('#speech-status')).toContainText('Download & start');
  await expect(page.locator('#avatar-canvas canvas')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('milo-device-desktop-real.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('milo-device-mobile-real.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await expect(page.locator('#conversation-engines')).toContainText('not loaded');
  expect(requests.filter(url => /audio-client|chat-client|\.gguf|\.onnx|\.wasm/.test(url))).toEqual([]);
  expectPrivate(requests); expect(errors).toEqual([]);
});

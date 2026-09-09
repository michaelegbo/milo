import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Mode = 'fast' | 'quality' | 'hybrid';
type AccelerationStatus = 'detecting' | 'ready' | 'switching' | 'unavailable' | 'error';

async function setupAcceleration(page: Page, initialStatus: AccelerationStatus = 'ready') {
  const engine = { status: 'ready', device: 'cpu', progress: 100, voices: ['am_michael', 'af_heart', 'bf_emma'] };
  const state = {
    mode: 'fast' as Mode, available: initialStatus === 'ready', enabled: false,
    status: initialStatus, device: 'cpu' as 'cpu' | 'gpu', revision: 0,
    message: initialStatus === 'detecting' ? 'Checking this computer for a compatible GPU.' : initialStatus === 'unavailable' ? 'No compatible GPU was found. Milo can still use the CPU.' : 'GPU detected. Acceleration is optional.',
    chatLoading: false, holdReply: false, holdSpeech: false, speechSeconds: 0.3,
    releaseReply: undefined as undefined | (() => void), releaseSpeech: undefined as undefined | (() => void),
    spoken: 0, replyText: 'Hello, lovely to meet you.', replyProfile: 'fast' as 'fast' | 'quality',
    selectedModel: 'fast' as 'fast' | 'quality',
    fastDevice: 'cpu' as 'cpu' | 'gpu', qualityDevice: 'cpu' as 'cpu' | 'gpu',
  };
  const switches: boolean[] = [];
  const turns: any[] = [];
  const health = () => ({ stt: engine, tts: engine, chat: {
    ...engine, profile: state.mode, device: state.device,
    status: state.chatLoading ? 'loading' : 'ready', progress: state.chatLoading ? 40 : 100,
    queueDepth: 0, selectedModel: state.selectedModel, residency: 'dual',
    residencyReason: 'Both local models fit in memory.',
    residentModels: { fast: { status: 'ready', device: state.fastDevice }, quality: { status: 'ready', device: state.qualityDevice } },
    acceleration: {
      available: state.available, enabled: state.enabled, status: state.status,
      backend: state.available ? 'vulkan' : null, deviceName: state.available ? 'Test GPU · 8 GB' : null,
      message: state.message, revision: state.revision,
    },
  } });
  const completeSwitch = (device: 'cpu' | 'gpu') => {
    state.device = device; state.enabled = device === 'gpu'; state.status = 'ready'; state.chatLoading = false;
    state.fastDevice = device; state.qualityDevice = device;
    state.message = device === 'gpu' ? 'Your GPU is accelerating Milo’s replies.' : 'Milo is using the CPU. GPU acceleration is off.';
  };
  await page.addInitScript(() => {
    (window as any).__gpuMicCalls = 0;
    (window as any).__gpuAudioStarts = 0;
    (window as any).__gpuAudioStops = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).__gpuMicCalls++;
      throw new DOMException('GPU control tests must not open the physical microphone.', 'NotAllowedError');
    };
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      (window as any).__gpuAudioStarts++;
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      (window as any).__gpuAudioStops++;
      return stop.apply(this, args);
    };
  });
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: health() }));
  await page.route('**/api/conversation/prepare', route => {
    state.mode = route.request().postDataJSON().profile;
    return route.fulfill({ status: 202, json: health() });
  });
  await page.route('**/api/conversation/acceleration', route => {
    const { enabled } = route.request().postDataJSON();
    expect(typeof enabled).toBe('boolean');
    switches.push(enabled); state.enabled = enabled; state.revision++;
    state.status = 'switching'; state.chatLoading = true;
    state.message = enabled ? 'Preparing Milo on your GPU.' : 'Returning Milo to the CPU.';
    return route.fulfill({ status: 202, json: health() });
  });
  await page.route('**/api/chat/stream', async route => {
    turns.push(route.request().postDataJSON());
    const text = state.replyText, replyProfile = state.replyProfile;
    state.selectedModel = replyProfile;
    if (state.holdReply) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 15000);
      state.releaseReply = () => { clearTimeout(timer); resolve(); };
    });
    await route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'routing', profile: replyProfile, reason: replyProfile === 'fast' ? 'A straightforward conversational turn.' : 'This question benefits from more careful reasoning.' },
      { type: 'delta', text },
      { type: 'done', text, profile: replyProfile, mode: state.mode, device: state.device, generationMs: 100 },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' }).catch(() => {});
  });
  const source = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  await page.route('**/api/speech', async route => {
    state.spoken++;
    const speech = Buffer.from(source.subarray(0, 44 + Math.floor(16000 * 2 * state.speechSeconds)));
    speech.writeUInt32LE(speech.length - 8, 4); speech.writeUInt32LE(speech.length - 44, 40);
    if (state.holdSpeech) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 15000);
      state.releaseSpeech = () => { clearTimeout(timer); resolve(); };
    });
    await route.fulfill({ contentType: 'audio/wav', body: speech }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  return { state, switches, turns, completeSwitch };
}

async function send(page: Page, turns: any[], text: string) {
  const count = turns.length;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => turns.length).toBe(count + 1);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
}

async function finishRequestedSwitch(state: { status: AccelerationStatus }, completeSwitch: (device: 'cpu' | 'gpu') => void, device: 'cpu' | 'gpu') {
  await expect.poll(() => state.status).toBe('switching');
  completeSwitch(device);
}

test('GPU detection and unsupported hardware leave CPU conversation usable', async ({ page }) => {
  const { state, switches, turns } = await setupAcceleration(page, 'detecting');
  const toggle = page.getByRole('switch', { name: 'GPU acceleration' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeDisabled();
  await expect(page.locator('#gpu-status')).toContainText(/checking|detecting/i);
  state.status = 'unavailable';
  state.message = 'No compatible GPU was found. Milo can still use the CPU.';
  await expect(page.locator('#gpu-status')).toContainText(/no compatible GPU/i);
  await expect(toggle).toBeDisabled();
  await send(page, turns, 'Hello!');
  await expect(page.locator('.conversation-message.assistant')).toContainText('Hello, lovely to meet you.');
  expect(switches).toEqual([]);
  expect(await page.evaluate(() => (window as any).__gpuMicCalls)).toBe(0);
});

test('GPU on and off retain Hybrid mode, conversation history and explicit memory at desktop and mobile sizes', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { state, switches, turns, completeSwitch } = await setupAcceleration(page);
  await page.getByLabel('MILO’S MIND').selectOption('hybrid');
  await send(page, turns, 'My name is Amara.');
  const toggle = page.getByRole('switch', { name: 'GPU acceleration' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#gpu-device')).toContainText('Test GPU');
  await toggle.click();
  await expect.poll(() => switches).toEqual([true]);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await expect(toggle).toBeEnabled();
  completeSwitch('gpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('#gpu-status')).toContainText(/GPU/i);
  await send(page, turns, 'What name did I tell you?');
  expect(turns[1].messages[0].content).toBe('My name is Amara.');
  expect(turns[1].memory.facts.join(' ')).toContain('Amara');
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await page.screenshot({ path: testInfo.outputPath('gpu-desktop-ready.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ['gpu-toggle', 'gpu-status', 'gpu-device', 'conversation-model', 'conversation-input']) await expect(page.locator(`#${id}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('gpu-mobile-ready.png'), fullPage: true });
  await toggle.click();
  await expect.poll(() => switches).toEqual([true, false]);
  completeSwitch('cpu');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#gpu-status')).toContainText(/CPU/i);
  await expect(page.locator('#conversation-start')).toBeEnabled();
  state.replyText = 'Yes, your name is Amara.';
  await send(page, turns, 'And now, what is my name?');
  expect(turns[2].messages).toHaveLength(5);
  expect(turns[2].memory.facts.join(' ')).toContain('Amara');
  expect(turns.every(turn => turn.profile === 'hybrid')).toBe(true);
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await expect(page.locator('#memory-detail')).toContainText('Amara');
  await page.screenshot({ path: testInfo.outputPath('gpu-mobile-cpu.png'), fullPage: true });
  expect(await page.evaluate(() => (window as any).__gpuMicCalls)).toBe(0);
  expect(errors).toEqual([]);
});

test('turning GPU off during a pending reply ignores its late text and speech', async ({ page }) => {
  const { state, switches, turns, completeSwitch } = await setupAcceleration(page);
  const toggle = page.getByRole('switch', { name: 'GPU acceleration' });
  await toggle.click(); await finishRequestedSwitch(state, completeSwitch, 'gpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await send(page, turns, 'Hello!');
  const spokenBefore = state.spoken;
  const startsBefore = await page.evaluate(() => (window as any).__gpuAudioStarts);
  state.holdReply = true; state.replyText = 'This old GPU reply must never appear.';
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Please think about this question.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseReply)).toBe(true);
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect.poll(() => switches).toEqual([true, false]);
  state.releaseReply!(); completeSwitch('cpu');
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(1);
  await expect(page.locator('#conversation-log')).not.toContainText('This old GPU reply');
  await expect(page.locator('.audio-strip')).not.toHaveClass(/is-playing/);
  expect(state.spoken).toBe(spokenBefore);
  expect(await page.evaluate(() => (window as any).__gpuAudioStarts)).toBe(startsBefore);
});

test('turning GPU off stops active audio and cancels pending speech preparation', async ({ page }) => {
  const { state, turns, completeSwitch } = await setupAcceleration(page);
  const toggle = page.getByRole('switch', { name: 'GPU acceleration' });
  await toggle.click(); await finishRequestedSwitch(state, completeSwitch, 'gpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  state.speechSeconds = 4;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Hello!');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking');
  const stopsBefore = await page.evaluate(() => (window as any).__gpuAudioStops);
  await toggle.click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.audio-strip')).not.toHaveClass(/is-playing/);
  expect(await page.evaluate(() => (window as any).__gpuAudioStops)).toBeGreaterThan(stopsBefore);
  await finishRequestedSwitch(state, completeSwitch, 'cpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await toggle.click(); await finishRequestedSwitch(state, completeSwitch, 'gpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  state.holdSpeech = true;
  const startsBefore = await page.evaluate(() => (window as any).__gpuAudioStarts);
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Tell me something else.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseSpeech)).toBe(true);
  await toggle.click(); state.releaseSpeech!(); await finishRequestedSwitch(state, completeSwitch, 'cpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.audio-strip')).not.toHaveClass(/is-playing/);
  expect(await page.evaluate(() => (window as any).__gpuAudioStarts)).toBe(startsBefore);
  expect(turns).toHaveLength(2);
});

test('GPU can be disabled while warming and a shared device revision cancels an obsolete reply before CPU fallback', async ({ page }) => {
  const { state, switches, turns, completeSwitch } = await setupAcceleration(page);
  const toggle = page.getByRole('switch', { name: 'GPU acceleration' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect.poll(() => switches).toEqual([true, false]);
  completeSwitch('cpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await toggle.click(); await finishRequestedSwitch(state, completeSwitch, 'gpu');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  state.holdReply = true; state.replyText = 'This reply belongs to the old device revision.';
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Hello!');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseReply)).toBe(true);
  // Another tab requested CPU, or the GPU failed: authoritative health is shared.
  state.revision++; completeSwitch('cpu'); state.status = 'error';
  state.message = 'The GPU could not continue. Milo returned to the CPU.';
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#gpu-status')).toContainText(/returned to the CPU/i);
  state.releaseReply!();
  await page.waitForTimeout(300);
  await expect(page.locator('#conversation-log')).not.toContainText('old device revision');
  expect(state.spoken).toBe(0);
  state.holdReply = false; state.replyText = 'Milo is ready on the CPU.';
  await send(page, turns, 'Hello again!');
  await expect(page.locator('.conversation-message.assistant')).toContainText('Milo is ready on the CPU.');
  expect(await page.evaluate(() => (window as any).__gpuMicCalls)).toBe(0);
});

test('mixed Hybrid keeps GPU ready while quick replies use CPU and hands deeper replies to GPU without cancelling the turn', async ({ page }) => {
  const { state, switches, turns, completeSwitch } = await setupAcceleration(page);
  await page.getByLabel('MILO’S MIND').selectOption('hybrid');
  const toggle = page.getByRole('switch', { name: 'GPU acceleration' });
  await toggle.click();
  await finishRequestedSwitch(state, completeSwitch, 'gpu');
  state.fastDevice = 'cpu'; state.device = 'cpu';
  state.message = 'Hybrid keeps quick replies on CPU and deeper replies on GPU.';
  const revision = state.revision;
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#gpu-status')).toContainText(/GPU ready.*quick replies use CPU/i);
  await expect(page.locator('#gpu-status')).not.toContainText(/preparing/i);
  await send(page, turns, 'My name is Amara.');
  await expect(page.locator('#route-label')).toHaveText('Quick reply');

  state.replyProfile = 'quality'; state.replyText = 'Here are the important tradeoffs to consider.';
  state.holdReply = true;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Compare several approaches to learning a new language.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseReply)).toBe(true);
  // A per-turn CPU/GPU handoff does not change the acceleration revision.
  state.device = 'gpu';
  await expect(page.locator('#gpu-status')).toHaveText('GPU active');
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'thinking');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  state.releaseReply!(); state.holdReply = false;
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(2);
  await expect(page.locator('#conversation-log')).toContainText('important tradeoffs');
  await expect(page.locator('#route-label')).toHaveText('Considered reply');
  expect(state.spoken).toBe(2);

  state.replyProfile = 'fast'; state.replyText = 'You are welcome, Amara.'; state.device = 'cpu';
  await expect(page.locator('#gpu-status')).toContainText(/GPU ready.*quick replies use CPU/i);
  await send(page, turns, 'Thanks!');
  await expect(page.locator('#route-label')).toHaveText('Quick reply');
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(turns[2].messages).toHaveLength(5);
  expect(turns[2].memory.facts.join(' ')).toContain('Amara');
  expect(state.revision).toBe(revision);
  expect(switches).toEqual([true]);
  expect(state.spoken).toBe(3);
  expect(await page.evaluate(() => (window as any).__gpuMicCalls)).toBe(0);
});

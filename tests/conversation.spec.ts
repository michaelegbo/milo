import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('./fixtures/microphone.wav', import.meta.url))}`] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = (window as any).__mic = { calls: 0, tracks: [] as MediaStreamTrack[], peak: 0 };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.calls++;
      const stream = await get(constraints);
      state.tracks.push(...stream.getTracks());
      return stream;
    };
    const analyse = AnalyserNode.prototype.getByteTimeDomainData;
    AnalyserNode.prototype.getByteTimeDomainData = function(data) {
      analyse.call(this, data);
      state.peak = Math.max(state.peak, Array.from(data).reduce((sum, value) => sum + Math.abs(value - 128), 0) / data.length);
    };
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled({ timeout: 120_000 });
});

test('typed conversation remembers context, speaks real audio, stays private to the tab and fits mobile', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('My favourite colour is purple. Please remember it.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking', { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__mic.peak)).toBeGreaterThan(2);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Which colour did I tell you is my favourite?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(2, { timeout: 90_000 });
  await expect(page.locator('.conversation-message.assistant').last()).toContainText(/purple/i);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking', { timeout: 90_000 });
  await page.screenshot({ path: testInfo.outputPath('conversation-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__mic.calls)).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('purple');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('conversation-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Sentence studio' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.conversation-message')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('synthetic microphone completes the real STT-chat-TTS loop, releases capture, resumes and stops', async ({ page }, testInfo) => {
  // This regression covers the explicit interrupt button and half-duplex loop.
  await page.locator('#conversation-interrupt').uncheck();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'listening');
  await expect(page.locator('.conversation-message.user')).toHaveCount(1, { timeout: 35_000 });
  await expect(page.locator('.conversation-message.user')).toContainText(/avatar/i);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking', { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__mic.peak)).toBeGreaterThan(2);
  expect(await page.evaluate(() => (window as any).__mic.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('voice-conversation.png'), fullPage: true });
  // Let the first response finish: continuous mode must start exactly one new capture.
  await expect.poll(() => page.evaluate(() => (window as any).__mic.calls), { timeout: 60_000 }).toBe(2);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'listening');
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__mic.calls)).toBe(2);
  expect(await page.evaluate(() => (window as any).__mic.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  // A typed reply can also be interrupted to take the next voice turn.
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Tell me a short interesting fact about the moon.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Interrupt & talk' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Interrupt & talk' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__mic.calls)).toBe(3);
  await page.getByRole('tab', { name: 'Sentence studio' }).click();
  expect(await page.evaluate(() => (window as any).__mic.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
});

test('denied microphone preserves typing; ending a pending reply prevents late audio', async ({ page }) => {
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied for testing', 'NotAllowedError'); }; });
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.locator('#conversation-status')).toContainText('Microphone access was blocked');
  let resolveReply: (() => void) | undefined;
  await page.route('**/api/chat/stream', async route => {
    await new Promise<void>(resolve => { resolveReply = resolve; });
    const text = 'This cancelled reply must never be spoken.';
    await route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', text })}\n` }).catch(() => {});
  });
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Hello Milo.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'thinking');
  await expect.poll(() => !!resolveReply).toBe(true);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  resolveReply!();
  await page.waitForTimeout(600);
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(0);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await page.unroute('**/api/chat/stream');
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Say a friendly hello.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking', { timeout: 90_000 });
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
});

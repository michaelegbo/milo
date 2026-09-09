import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('./fixtures/microphone.wav', import.meta.url))}`] } });

async function changedPixels(first: Buffer, second: Buffer, area: 'face' | 'body' = 'face') {
  const metadata = await sharp(first).metadata();
  const crop = { left: Math.floor(metadata.width! * 0.20), top: Math.floor(metadata.height! * (area === 'face' ? 0.08 : 0.60)), width: Math.floor(metadata.width! * 0.65), height: Math.floor(metadata.height! * (area === 'face' ? 0.50 : 0.30)) };
  const [a, b] = await Promise.all([first, second].map(buffer => sharp(buffer).extract(crop).removeAlpha().raw().toBuffer()));
  expect(a.length).toBe(b.length);
  let changed = 0;
  for (let index = 0; index < a.length; index += 3) {
    if (Math.max(Math.abs(a[index] - b[index]), Math.abs(a[index + 1] - b[index + 1]), Math.abs(a[index + 2] - b[index + 2])) > 12) changed++;
  }
  return changed / (a.length / 3);
}

async function reply(route: Route, text: string) {
  if (route.request().url().endsWith('/stream')) {
    await route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', text, generationMs: 100, firstChunkMs: 30, model: 'fixture', device: 'cpu', profile: 'fast' })}\n` });
  } else await route.fulfill({ json: { text } });
}

async function quietMotion(page: Page) {
  if (await page.getByRole('checkbox', { name: 'Idle motion' }).isChecked()) await page.locator('.motion-toggle').click();
  if (await page.getByRole('checkbox', { name: 'Talking gestures' }).isChecked()) await page.locator('.gesture-toggle').click();
}

test.beforeEach(async ({ page }) => {
  const engine = { status: 'ready', device: 'cpu', progress: 100, profile: 'fast', voices: ['af_heart', 'am_michael', 'bf_emma'] };
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: { stt: engine, chat: engine, tts: engine } }));
  await page.route('**/api/conversation/prepare', route => route.fulfill({ status: 202, json: { stt: engine, chat: engine, tts: engine } }));
  await page.route('**/api/transcribe', route => route.fulfill({ json: { text: 'Tell me something interesting.', duration: 1 } }));
  const speech = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  await page.route('**/api/speech', route => route.fulfill({ contentType: 'audio/wav', body: speech, headers: { 'X-Audio-Duration': '8.525' } }));
});

test('visible face follows actual listening, thinking, voiced speech and rest without opening during pending permission', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseReply: (() => void) | undefined;
  await page.route('**/api/chat{,/stream}', async route => {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 15000);
      releaseReply = () => { clearTimeout(timeout); resolve(); };
    });
    await reply(route, 'Here is something interesting about our little world.');
  });
  await page.goto('/');
  await quietMotion(page);
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await page.locator('#conversation-loop').uncheck();
  const interruption = page.locator('#conversation-interrupt');
  if (await interruption.count()) await interruption.uncheck();
  const canvas = page.locator('#avatar-canvas canvas');
  await expect(canvas).toHaveAttribute('aria-label', /ready to talk/);
  await page.waitForTimeout(350);
  const idle = await canvas.screenshot({ path: testInfo.outputPath('presence-idle.png') });
  await page.evaluate(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const permission = new Promise<void>(resolve => window.addEventListener('grant-synthetic-mic', () => resolve(), { once: true }));
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await get(constraints);
      await permission;
      return stream;
    };
  });
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Waiting for permission');
  await expect(canvas).toHaveAttribute('aria-label', /ready to talk/);
  const waiting = await canvas.screenshot({ path: testInfo.outputPath('presence-awaiting-permission.png') });
  expect(await changedPixels(idle, waiting)).toBeLessThan(0.0005);
  await page.evaluate(() => window.dispatchEvent(new Event('grant-synthetic-mic')));
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await expect(canvas).toHaveAttribute('aria-label', /listening attentively/);
  await expect.poll(async () => Number(await page.locator('#mic-meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.waitForTimeout(650);
  const listening = await canvas.screenshot({ path: testInfo.outputPath('presence-listening.png') });
  expect(await changedPixels(idle, listening)).toBeGreaterThan(0.0001);
  await page.locator('#conversation-start').click();
  await expect(page.locator('#conversation-panel'), await page.locator('#conversation-status').innerText()).toHaveAttribute('data-state', 'thinking');
  await expect.poll(() => Boolean(releaseReply)).toBe(true);
  await expect(canvas).toHaveAttribute('aria-label', /thinking/);
  const thinking = await canvas.screenshot({ path: testInfo.outputPath('presence-thinking.png') });
  expect(await changedPixels(listening, thinking)).toBeGreaterThan(0.0001);
  releaseReply!();
  await expect(canvas).toHaveAttribute('aria-label', /speaking/);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking');
  const speakingA = await canvas.screenshot({ path: testInfo.outputPath('presence-speaking-a.png') });
  await page.waitForTimeout(260);
  const speakingB = await canvas.screenshot({ path: testInfo.outputPath('presence-speaking-b.png') });
  expect(await changedPixels(speakingA, speakingB)).toBeGreaterThan(0.0001);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect(canvas).toHaveAttribute('aria-label', /ready to talk/);
  await page.waitForTimeout(1000);
  const restA = await canvas.screenshot({ path: testInfo.outputPath('presence-rest.png') });
  await page.waitForTimeout(250);
  const restB = await canvas.screenshot();
  expect(await changedPixels(restA, restB)).toBeLessThan(0.0005);
  expect(errors).toEqual([]);
});

test('reduced motion keeps the body still while real speech still changes the mouth and pause returns to rest', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: 'Idle motion' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Talking gestures' })).not.toBeChecked();
  const canvas = page.locator('#avatar-canvas canvas');
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  await expect(page.getByRole('button', { name: 'Pause Milo' })).toBeVisible();
  const first = await canvas.screenshot({ path: testInfo.outputPath('reduced-motion-speaking-a.png') });
  await page.waitForTimeout(300);
  const second = await canvas.screenshot({ path: testInfo.outputPath('reduced-motion-speaking-b.png') });
  expect(await changedPixels(first, second, 'body')).toBeLessThan(0.0005);
  expect(await changedPixels(first, second, 'face')).toBeGreaterThan(0.0001);
  await page.getByRole('button', { name: 'Pause Milo' }).click();
  await page.waitForTimeout(900);
  const pausedA = await canvas.screenshot({ path: testInfo.outputPath('reduced-motion-paused.png') });
  await page.waitForTimeout(250);
  const pausedB = await canvas.screenshot();
  expect(await changedPixels(pausedA, pausedB)).toBeLessThan(0.0005);
  expect(errors).toEqual([]);
});

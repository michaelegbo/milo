import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('real CPU speech reaches the audio graph, animates, pauses, resumes, ends, and downloads', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = AnalyserNode.prototype.getByteTimeDomainData;
    (window as any).__audioPeak = 0;
    AnalyserNode.prototype.getByteTimeDomainData = function(array) {
      original.call(this, array);
      let sum = 0;
      for (const value of array) sum += Math.abs(value - 128);
      (window as any).__audioPeak = Math.max((window as any).__audioPeak, sum / array.length);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('#avatar-canvas canvas')).toBeVisible();
  await page.locator('.motion-toggle').click();
  await page.screenshot({ path: testInfo.outputPath('desktop-ready.png'), fullPage: true });
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/speech'), { timeout: 30_000 });
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('audio/wav');
  await expect(page.getByRole('button', { name: 'Pause Milo' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__audioPeak)).toBeGreaterThan(2);
  await page.screenshot({ path: testInfo.outputPath('desktop-speaking.png'), fullPage: true });
  await page.getByRole('button', { name: 'Pause Milo' }).click();
  await expect(page.getByRole('button', { name: 'Keep talking' })).toBeVisible();
  const pausedTime = await page.locator('#track-time').textContent();
  await page.waitForTimeout(1100);
  expect(await page.locator('#track-time').textContent()).toBe(pausedTime);
  await page.getByRole('button', { name: 'Keep talking' }).click();
  await expect(page.getByRole('button', { name: 'Pause Milo' })).toBeVisible();
  await expect(page.locator('#speech-status')).toContainText('That’s a wrap', { timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download generated speech as WAV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('milo-speech.wav');
  const audioFile = await readFile((await download.path())!);
  expect(audioFile.subarray(0, 4).toString()).toBe('RIFF');
  expect(audioFile.length).toBeGreaterThan(100_000);
  expect(errors).toEqual([]);
});

test('custom text, voice and speed persist; blank text stays disabled; mobile remains usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Write your own' }).click();
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Your words, Milo’s voice.' }).fill('Hello! This is my own sentence.');
  await page.getByRole('combobox', { name: 'VOICE', exact: true }).selectOption('bf_emma');
  await page.getByRole('slider', { name: 'Speech pace' }).fill('0.8');
  await page.locator('.gesture-toggle').click();
  await page.reload();
  await expect(page.getByRole('textbox')).toHaveValue('Hello! This is my own sentence.');
  await expect(page.locator('#voice')).toHaveValue('bf_emma');
  await expect(page.locator('#speed')).toHaveValue('0.8');
  await expect(page.getByRole('checkbox', { name: 'Talking gestures' })).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('mobile-custom.png'), fullPage: true });
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  await expect(page.getByRole('button', { name: 'Pause Milo' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Stop speech', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  await expect(page.locator('#track-time')).toContainText('0:00');
});

test('cancelled generation cannot start late audio and a failed request can be retried', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  let attempts = 0;
  await page.route('**/api/speech', async route => {
    attempts++;
    if (attempts === 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Test generation failure. Try again.' }) }).catch(() => {});
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  await expect(page.getByRole('button', { name: 'Finding Milo’s voice…' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop speech', exact: true }).click();
  await page.waitForTimeout(1400);
  await expect(page.getByRole('button', { name: 'Let Milo speak' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Pause Milo' })).toHaveCount(0);
  await page.unroute('**/api/speech');
  await page.route('**/api/speech', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Test generation failure. Try again.' }) }));
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  await expect(page.locator('#speech-status')).toContainText('Test generation failure');
  await page.unroute('**/api/speech');
  await page.getByRole('button', { name: 'Let Milo speak' }).click();
  await expect(page.getByRole('button', { name: 'Pause Milo' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop speech', exact: true }).click();
});

test('keyboard tabs, reduced motion, dialog and voice reconnection work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#motion')).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Talking gestures' })).not.toBeChecked();
  await page.getByRole('tab', { name: 'Pick a sentence' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Write your own' })).toBeFocused();
  await expect(page.locator('#custom-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Behind the voice' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.route('**/api/health', route => route.fulfill({ status: 503 }));
  await expect(page.getByRole('button', { name: 'Reconnect to the voice' })).toBeVisible({ timeout: 12_000 });
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: 'Reconnect to the voice' }).click();
  await expect(page.locator('#engine-label')).toContainText('CPU ready');
});

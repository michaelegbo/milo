import { test, expect } from '@playwright/test';

test('profile selection recovers from a draining-worker 409 and labels the actual ready model', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__profileMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).__profileMicCalls++;
      throw new DOMException('Microphone is never needed for this test.', 'NotAllowedError');
    };
  });
  const engine = { status: 'ready', device: 'cpu', progress: 100, message: 'Ready.', voices: ['af_heart', 'am_michael', 'bf_emma'] };
  let activeProfile = 'fast';
  let queueDepth = 0;
  let qualityAttempts = 0;
  const health = () => ({ stt: engine, tts: engine, chat: { ...engine, profile: activeProfile, queueDepth } });
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: health() }));
  await page.route('**/api/conversation/prepare', async route => {
    const requested = route.request().postDataJSON().profile;
    if (requested === 'quality') {
      qualityAttempts++;
      if (qualityAttempts === 1) {
        // The previous worker became busy between the last poll and selection.
        queueDepth = 1;
        await route.fulfill({ status: 409, json: { error: 'profile_busy', message: 'Finish or stop the current turn before changing profiles.' } });
        return;
      }
      activeProfile = 'quality';
    }
    await route.fulfill({ status: 202, json: health() });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await page.locator('#conversation-model').selectOption('quality');
  await expect.poll(() => qualityAttempts).toBe(1);
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await expect(page.locator('#conversation-engines')).toContainText('Qwen 1.5B ✓');
  await expect(page.locator('#conversation-model')).toBeDisabled();
  queueDepth = 0;
  await expect.poll(() => qualityAttempts, { timeout: 10000 }).toBe(2);
  await expect(page.locator('#conversation-engines')).toContainText('Qwen 4B ✓');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('#conversation-model')).toHaveValue('quality');
  await expect(page.locator('#conversation-model')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__profileMicCalls)).toBe(0);
  expect(errors).toEqual([]);
});

test('a loading model prevents switching profiles until initialization finishes', async ({ page }) => {
  const engine = { status: 'ready', device: 'cpu', progress: 100, message: 'Ready.' };
  let loading = true;
  const requests: string[] = [];
  const health = () => ({ stt: engine, tts: engine, chat: { ...engine, profile: 'fast', status: loading ? 'loading' : 'ready', progress: loading ? 45 : 100, queueDepth: 0 } });
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: health() }));
  await page.route('**/api/conversation/prepare', route => {
    requests.push(route.request().postDataJSON().profile);
    return route.fulfill({ status: 202, json: health() });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-engines')).toContainText('Qwen 1.5B 45%');
  await expect(page.locator('#conversation-model')).toBeDisabled();
  await expect(page.locator('#conversation-start')).toBeDisabled();
  loading = false;
  await expect(page.locator('#conversation-model')).toBeEnabled();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  expect(requests).toEqual(['fast']);
});

test('an idle tab adopts another tab’s loading and ready profile without reloading its former model', async ({ page }) => {
  const engine = { status: 'ready', device: 'cpu', progress: 100, message: 'Ready.' };
  let actualProfile = 'fast';
  let loading = false;
  let healthPolls = 0;
  const requests: string[] = [];
  const health = () => ({ stt: engine, tts: engine, chat: { ...engine, profile: actualProfile, status: loading ? 'loading' : 'ready', progress: loading ? 45 : 100, queueDepth: 0 } });
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => {
    healthPolls++;
    return route.fulfill({ json: health() });
  });
  await page.route('**/api/conversation/prepare', route => {
    requests.push(route.request().postDataJSON().profile);
    return route.fulfill({ status: 202, json: health() });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('#conversation-model')).toHaveValue('fast');

  // Another visible tab changes the single shared CPU engine to Quality.
  actualProfile = 'quality'; loading = true;
  await expect(page.locator('#conversation-engines')).toContainText('Qwen 4B 45%');
  await expect(page.locator('#conversation-model')).toBeDisabled();
  await expect(page.locator('#conversation-start')).toBeDisabled();
  expect(requests).toEqual(['fast']);

  loading = false;
  await expect(page.locator('#conversation-engines')).toContainText('Qwen 4B ✓');
  await expect(page.locator('#conversation-model')).toHaveValue('quality');
  await expect(page.locator('#conversation-model')).toBeEnabled();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  const settledPollCount = healthPolls;
  await expect.poll(() => healthPolls, { timeout: 10000 }).toBeGreaterThanOrEqual(settledPollCount + 2);
  expect(requests).toEqual(['fast']);
});

import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Mode = 'fast' | 'quality' | 'hybrid';

async function setupHybrid(page: Page, initiallyLoading = false, singleResidency = false) {
  const engine = { status: 'ready', device: 'cpu', progress: 100, voices: ['am_michael', 'af_heart', 'bf_emma'] };
  const state = { mode: 'fast' as Mode, selectedModel: null as null | 'fast' | 'quality', hybridLoading: initiallyLoading, holdReply: false, releaseReply: undefined as undefined | (() => void), holdSpeech: false, releaseSpeech: undefined as undefined | (() => void), failReply: false, spoken: 0 };
  const prepared: string[] = [];
  const turns: any[] = [];
  const health = () => ({ stt: engine, tts: engine, chat: {
    ...engine, profile: state.mode, selectedModel: state.selectedModel, queueDepth: 0,
    status: state.mode === 'hybrid' && state.hybridLoading ? 'loading' : 'ready',
    progress: state.mode === 'hybrid' && state.hybridLoading ? 45 : 100,
    residency: singleResidency ? 'single' : 'dual', residencyReason: singleResidency ? 'Models load as needed to save memory.' : 'Both models fit in local memory.',
    residentModels: { fast: { status: 'ready' }, quality: { status: state.hybridLoading ? 'loading' : singleResidency && state.selectedModel !== 'quality' ? 'unloaded' : 'ready' } },
  } });
  await page.addInitScript(() => {
    (window as any).__hybridMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).__hybridMicCalls++;
      throw new DOMException('Typed Hybrid tests must not request microphone access.', 'NotAllowedError');
    };
  });
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: health() }));
  await page.route('**/api/conversation/prepare', route => {
    state.mode = route.request().postDataJSON().profile;
    prepared.push(state.mode);
    return route.fulfill({ status: 202, json: health() });
  });
  await page.route('**/api/chat/stream', async route => {
    const body = route.request().postDataJSON();
    turns.push(body);
    const greeting = /^hello[!.]?$/i.test(body.messages.at(-1).content);
    const target = greeting ? 'fast' : 'quality';
    const reason = greeting ? 'A short greeting works well with the quick model.' : 'This question benefits from more careful reasoning.';
    const text = greeting ? 'Hello, lovely to meet you.' : 'I can help you consider those details.';
    if (state.holdReply) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15000);
        state.releaseReply = () => { clearTimeout(timer); resolve(); };
      });
    }
    state.selectedModel = target;
    if (state.failReply) {
      await route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'routing', profile: 'quality', reason: 'This question benefits from more careful reasoning.' },
        { type: 'error', code: 'model_load_failed', message: 'The deeper model could not start. Try again.' },
        { type: 'delta', text: 'This stale answer must never appear or be spoken.' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
      return;
    }
    await route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'routing', profile: target, reason },
      { type: 'delta', text },
      { type: 'done', text, profile: target, mode: 'hybrid', generationMs: 100, firstChunkMs: 20, device: 'cpu' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' }).catch(() => {});
  });
  const source = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  const speech = Buffer.from(source.subarray(0, 44 + 16000 * 2 * 0.35));
  speech.writeUInt32LE(speech.length - 8, 4); speech.writeUInt32LE(speech.length - 44, 40);
  await page.route('**/api/speech', async route => {
    state.spoken++;
    if (state.holdSpeech) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15000);
        state.releaseSpeech = () => { clearTimeout(timer); resolve(); };
      });
    }
    return route.fulfill({ contentType: 'audio/wav', body: speech });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await page.getByLabel('MILO’S MIND').selectOption('hybrid');
  return { state, prepared, turns };
}

async function send(page: Page, turns: any[], text: string) {
  const count = turns.length;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => turns.length).toBe(count + 1);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
}

test('Hybrid selection waits for readiness and exposes its per-reply routing without microphone access', async ({ page }) => {
  const { state, prepared } = await setupHybrid(page, true);
  await expect(page.getByLabel('MILO’S MIND')).toHaveValue('hybrid');
  await expect(page.locator('#conversation-model')).toBeDisabled();
  await expect(page.locator('#conversation-start')).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Hello!');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(page.locator('#conversation-route')).toBeVisible();
  await expect(page.locator('#route-label')).toHaveText('Chooses for each reply');
  state.hybridLoading = false;
  await expect(page.locator('#conversation-engines')).toContainText('Hybrid ✓');
  await expect(page.locator('#conversation-model')).toBeEnabled();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect(prepared).toEqual(['fast', 'hybrid']);
  expect(await page.evaluate(() => (window as any).__hybridMicCalls)).toBe(0);
});

test('Hybrid displays quick and considered routes while retaining mode, prior turns and explicit memory', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { state, turns, prepared } = await setupHybrid(page);
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await send(page, turns, 'Hello!');
  await expect(page.locator('#route-label')).toHaveText('Quick reply');
  await expect(page.locator('#route-reason')).toContainText('short greeting');
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await page.screenshot({ path: testInfo.outputPath('hybrid-desktop-quick.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('hybrid-mobile-quick.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1024 });
  state.holdSpeech = true;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('My name is Amara. Compare the tradeoffs of learning piano alone versus taking lessons.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseSpeech)).toBe(true);
  await expect(page.locator('#route-label')).toHaveText('Thinking deeper');
  await page.screenshot({ path: testInfo.outputPath('hybrid-desktop-thinking.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ['conversation-model', 'mic-device', 'mic-toggle', 'conversation-voice', 'conversation-start', 'conversation-input']) await expect(page.locator(`#${id}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hybrid-mobile-thinking.png'), fullPage: true });
  state.holdSpeech = false;
  state.releaseSpeech!();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#route-label')).toHaveText('Considered reply');
  await expect(page.locator('#route-reason')).toContainText('careful reasoning');
  expect(turns[1].messages[0].content).toBe('Hello!');
  expect(turns[1].memory.facts.join(' ')).toContain('Amara');
  await send(page, turns, 'What name did I tell you?');
  expect(turns[2].messages).toHaveLength(5);
  expect(turns[2].memory.facts.join(' ')).toContain('Amara');
  expect(turns.every(turn => turn.profile === 'hybrid')).toBe(true);
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await expect(page.locator('#conversation-engines')).toContainText('Hybrid ✓');
  await expect(page.locator('#conversation-start')).toBeEnabled();
  expect(prepared).toEqual(['fast', 'hybrid']);
  expect(await page.evaluate(() => (window as any).__hybridMicCalls)).toBe(0);
  expect(errors).toEqual([]);
});

test('ending a pending Hybrid reply ignores late routing and speech without changing the selected mode', async ({ page }) => {
  const { state, turns } = await setupHybrid(page);
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await send(page, turns, 'Hello!');
  const spokenBefore = state.spoken;
  state.holdReply = true;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Compare several approaches to this difficult problem.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseReply)).toBe(true);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  const labelAfterEnd = await page.locator('#route-label').textContent();
  const reasonAfterEnd = await page.locator('#route-reason').textContent();
  state.releaseReply!();
  await page.waitForTimeout(600);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#route-label')).toHaveText(labelAfterEnd!);
  await expect(page.locator('#route-reason')).toHaveText(reasonAfterEnd!);
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(1);
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  expect(state.spoken).toBe(spokenBefore);
  expect(await page.evaluate(() => (window as any).__hybridMicCalls)).toBe(0);
});

test('a routed Quality error preserves Hybrid memory and history, stops stale output, and allows a successful retry', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { state, turns } = await setupHybrid(page, false, true);
  await expect(page.locator('#model-hint')).toBeVisible();
  await expect(page.locator('#model-hint')).toContainText(/models load as needed/i);
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await send(page, turns, 'My name is Amara.');
  const spokenBefore = state.spoken;
  state.failReply = true;
  await page.getByRole('textbox', { name: 'Message Milo' }).fill('Compare several ways to solve this difficult problem.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#conversation-status')).toContainText('The deeper model could not start');
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  await expect(page.locator('#memory-detail')).toContainText('Amara');
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(1);
  await expect(page.locator('#conversation-log')).not.toContainText('This stale answer');
  await expect(page.locator('.audio-strip')).not.toHaveClass(/is-playing/);
  expect(state.spoken).toBe(spokenBefore);
  expect(turns[1].messages[0].content).toBe('My name is Amara.');
  expect(turns[1].memory.facts.join(' ')).toContain('Amara');

  state.failReply = false;
  await send(page, turns, 'What name did I tell you?');
  await expect(page.locator('.conversation-message.assistant')).toHaveCount(2);
  await expect(page.locator('#conversation-model')).toHaveValue('hybrid');
  expect(turns[2].profile).toBe('hybrid');
  expect(turns[2].messages[0].content).toBe('My name is Amara.');
  expect(turns[2].messages).toHaveLength(3);
  expect(turns[2].memory.facts.join(' ')).toContain('Amara');
  expect(state.spoken).toBe(spokenBefore + 1);
  expect(await page.evaluate(() => (window as any).__hybridMicCalls)).toBe(0);
  expect(errors).toEqual([]);
});

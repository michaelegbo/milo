import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('older turns compact, explicit corrections survive the context window, and New chat clears both', async ({ page }) => {
  const base = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  const speech = Buffer.from(base.subarray(0, 44 + 3200));
  speech.writeUInt32LE(speech.length - 8, 4); speech.writeUInt32LE(speech.length - 44, 40);
  const engine = { status: 'ready', device: 'cpu', progress: 100, voices: ['am_michael'] };
  let profile = 'fast';
  const health = () => ({ stt: engine, tts: engine, chat: { ...engine, profile } });
  const turns: any[] = [], summaries: any[] = [], prepared: string[] = [], spoken: string[] = [];
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Typed chat must never request a microphone.'); };
  });
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: health() }));
  await page.route('**/api/conversation/prepare', route => {
    profile = route.request().postDataJSON().profile; prepared.push(profile);
    return route.fulfill({ status: 202, json: health() });
  });
  await page.route('**/api/chat/stream', route => {
    turns.push(route.request().postDataJSON());
    const parts = ['I ', 'remember ', 'that. ', 'Tell ', 'me ', 'more.'];
    return route.fulfill({ contentType: 'application/x-ndjson', body: [...parts.map(text => JSON.stringify({ type: 'delta', text })), JSON.stringify({ type: 'done', text: parts.join('') })].join('\n') + '\n' });
  });
  await page.route('**/api/chat/summary', route => {
    summaries.push(route.request().postDataJSON());
    return route.fulfill({ json: { summary: 'The user is planning a small garden and wants drought-tolerant plants.' } });
  });
  await page.route('**/api/speech', route => {
    spoken.push(route.request().postDataJSON().text);
    return route.fulfill({ contentType: 'audio/wav', body: speech });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const send = async (text: string) => {
    const count = turns.length;
    await page.getByRole('textbox', { name: 'Message Milo' }).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => turns.length).toBe(count + 1);
    await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  };
  await send('My name is Amara. My favourite colour is purple.');
  for (const text of ['I want a small garden.', 'It gets afternoon sun.', 'I have three pots.', 'I can water twice a week.', 'Which herbs work?', 'Would rosemary suit it?']) await send(text);
  await expect.poll(() => summaries.length).toBeGreaterThan(0);
  expect(summaries[0].messages.at(-1).role).toBe('assistant');
  expect(summaries[0].messages.length).toBeLessThanOrEqual(12);
  await send('Actually my name is Zoe. My favourite colour is blue.');
  const latest = turns.at(-1);
  expect(latest.messages.length).toBeLessThanOrEqual(11);
  expect(latest.memory.summary).toContain('garden');
  expect(latest.memory.facts.join(' ')).toContain('Zoe');
  expect(latest.memory.facts.join(' ')).toContain('blue');
  expect(latest.memory.facts.join(' ')).not.toMatch(/Amara|purple/);
  // Streamed words must become complete speech sentences, never one TTS call per word.
  expect(spoken.every(text => ['I remember that.', 'Tell me more.'].includes(text))).toBe(true);
  expect(spoken.length).toBe(turns.length * 2);
  await page.locator('.conversation-memory summary').click();
  await expect(page.locator('#memory-detail')).toContainText('Zoe');
  await expect(page.locator('#memory-detail')).toContainText('garden');
  await page.getByLabel('MILO’S MIND').selectOption('quality');
  await expect.poll(() => prepared.at(-1)).toBe('quality');
  await send('What do you remember?');
  expect(turns.at(-1).profile).toBe('quality');
  expect(turns.at(-1).memory.facts.join(' ')).toContain('Zoe');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(0);
  await expect(page.locator('#memory-count')).toHaveText('This chat only');
  await send('Hello again.');
  expect(turns.at(-1).messages).toHaveLength(1);
  expect(turns.at(-1).memory).toEqual({ summary: '', facts: [] });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/Amara|Zoe|garden/);
});

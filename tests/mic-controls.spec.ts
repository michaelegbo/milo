import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('./fixtures/microphone.wav', import.meta.url))}`] } });

const calls = (page: Page) => page.evaluate(() => (window as any).__micControls.calls.length);
const allTracksEnded = (page: Page) => page.evaluate(() => {
  const tracks: MediaStreamTrack[] = (window as any).__micControls.tracks;
  return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const harness = (window as any).__micControls = {
      calls: [] as MediaStreamConstraints[], tracks: [] as MediaStreamTrack[], enumerations: 0,
      devices: [{ deviceId: 'desk-mic', label: 'Desk microphone' }, { deviceId: 'usb-mic', label: 'USB headset' }],
      holdPermission: false, releasePermission: undefined as undefined | (() => void), transcriptions: 0,
      requirePermission: false, permissionGranted: false, denyPermission: false,
    };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      harness.calls.push(structuredClone(constraints));
      if (harness.denyPermission) throw new DOMException('Denied by test', 'NotAllowedError');
      // Record the app's exact hardware selection, while letting Chrome's one
      // synthetic device supply real audio without a physical microphone.
      const safe = structuredClone(constraints!);
      if (safe.audio && typeof safe.audio === 'object') delete safe.audio.deviceId;
      const stream = await get(safe);
      harness.tracks.push(...stream.getTracks());
      if (harness.holdPermission) await new Promise<void>(resolve => { harness.releasePermission = resolve; });
      harness.permissionGranted = true;
      return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => {
      harness.enumerations++;
      if (harness.requirePermission && !harness.permissionGranted) return [];
      return harness.devices.map((device: { deviceId: string; label: string }) => ({ ...device, kind: 'audioinput', groupId: 'synthetic', toJSON() { return { ...device, kind: 'audioinput', groupId: 'synthetic' }; } }));
    };
  });
  const engine = { status: 'ready', device: 'cpu', progress: 100, message: 'Ready.', voices: ['af_heart', 'am_michael', 'bf_emma'] };
  const health = { stt: engine, chat: engine, tts: engine };
  await page.route('**/api/health', route => route.fulfill({ json: engine }));
  await page.route('**/api/conversation/health', route => route.fulfill({ json: health }));
  await page.route('**/api/conversation/prepare', route => route.fulfill({ status: 202, json: health }));
  await page.route('**/api/transcribe', async route => {
    await page.evaluate(() => (window as any).__micControls.transcriptions++);
    await route.fulfill({ json: { text: 'Hello Milo.', duration: 1 } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('#conversation-start')).toBeEnabled();
  await expect(page.locator('#mic-device option[value="usb-mic"]')).toHaveCount(1);
});

test('refresh and unmute never capture; selected device is exact and muting discards the live recording', async ({ page }) => {
  await expect(page.locator('#mic-state')).toHaveText('Mic idle');
  await expect(page.locator('#mic-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await calls(page)).toBe(0);
  const enumerations = await page.evaluate(() => (window as any).__micControls.enumerations);
  await page.getByRole('button', { name: 'Refresh microphones' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__micControls.enumerations)).toBeGreaterThan(enumerations);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.locator('#mic-state')).toHaveText('Mic muted');
  await expect(page.locator('#conversation-start')).toHaveText('Unmute & talk');
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  expect(await calls(page)).toBe(0);
  await page.getByRole('combobox', { name: 'Microphone input' }).selectOption('usb-mic');
  expect(await calls(page)).toBe(0);
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  expect(await page.evaluate(() => (window as any).__micControls.calls[0].audio.deviceId)).toEqual({ exact: 'usb-mic' });
  await expect(page.locator('#mic-meter')).toHaveAttribute('role', 'meter');
  await expect.poll(async () => Number(await page.locator('#mic-meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.locator('#mic-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mic-state')).toHaveText('Mic muted');
  await expect(page.locator('#mic-meter')).toHaveAttribute('aria-valuenow', '0');
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).__micControls.transcriptions)).toBe(0);
  expect(await calls(page)).toBe(1);
});

test('muting an in-flight voice reply preserves playback and prevents automatic microphone restart', async ({ page }) => {
  const source = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  const speech = Buffer.from(source.subarray(0, 44 + 16000 * 2 * 2));
  speech.writeUInt32LE(speech.length - 8, 4);
  speech.writeUInt32LE(speech.length - 44, 40);
  let releaseReply: (() => void) | undefined;
  let speechRequests = 0;
  await page.route('**/api/chat{,/stream}', async route => {
    await new Promise<void>(resolve => { releaseReply = resolve; });
    const text = 'Hello, I am here to listen.';
    await route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', text })}\n` });
  });
  await page.route('**/api/speech', route => {
    speechRequests++;
    return route.fulfill({ contentType: 'audio/wav', body: speech, headers: { 'X-Audio-Duration': '2' } });
  });
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await expect.poll(async () => Number(await page.locator('#mic-meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  // Capture more than the recorder's 300 ms voiced-speech minimum.
  await page.waitForTimeout(600);
  await page.locator('#conversation-start').click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'thinking');
  await expect.poll(() => Boolean(releaseReply)).toBe(true);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'thinking');
  releaseReply!();
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking');
  await expect(page.locator('#mic-state')).toHaveText('Mic muted');
  await page.waitForTimeout(300);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking');
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(600);
  expect(speechRequests).toBe(1);
  expect(await calls(page)).toBe(1);
  expect(await allTracksEnded(page)).toBe(true);
  await expect(page.locator('#conversation-start')).toHaveText('Unmute & talk');
});

test('muting while permission is pending releases late tracks without sending audio or restarting', async ({ page }) => {
  await page.evaluate(() => { (window as any).__micControls.holdPermission = true; });
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Waiting for permission');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__micControls.releasePermission))).toBe(true);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.locator('#mic-state')).toHaveText('Mic muted');
  await page.evaluate(() => (window as any).__micControls.releasePermission());
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  expect(await page.evaluate(() => (window as any).__micControls.transcriptions)).toBe(0);
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  expect(await calls(page)).toBe(1);
  expect(await allTracksEnded(page)).toBe(true);
});

test('disconnecting the selected device clears its selection and ends capture without silently switching inputs', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Microphone input' }).selectOption('usb-mic');
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await page.evaluate(() => {
    const harness = (window as any).__micControls;
    harness.devices = harness.devices.filter((device: { deviceId: string }) => device.deviceId !== 'usb-mic');
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(page.getByRole('combobox', { name: 'Microphone input' })).toHaveValue('');
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  await expect(page.locator('#mic-state')).toHaveText(/Mic (paused|idle)/);
  await expect(page.locator('#conversation-panel')).not.toHaveAttribute('data-state', 'listening');
  expect(await page.evaluate(() => (window as any).__micControls.transcriptions)).toBe(0);
  await page.waitForTimeout(400);
  expect(await calls(page)).toBe(1);
});

test('a new voice onset interrupts Milo’s playback and keeps the same microphone capture for the next turn', async ({ page }) => {
  const speech = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  let replyRequests = 0;
  await page.route('**/api/chat/stream', route => {
    replyRequests++;
    const text = 'Hello there. I am here and ready to listen to you.';
    return route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', text })}\n` });
  });
  await page.route('**/api/speech', route => route.fulfill({ contentType: 'audio/wav', body: speech, headers: { 'X-Audio-Duration': '8.525' } }));
  await expect(page.locator('#conversation-interrupt')).toBeChecked();
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await expect.poll(async () => Number(await page.locator('#mic-meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const replyAudio = page.waitForResponse('**/api/speech');
  await page.locator('#conversation-start').click();
  await replyAudio;
  // Capture 1 was the original voice message. Capture 2 monitors the reply and
  // must be promoted in place when the synthetic microphone starts speaking.
  await expect.poll(() => calls(page)).toBe(2);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'listening');
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await expect(page.locator('.audio-strip')).not.toHaveClass(/is-playing/);
  expect(await calls(page)).toBe(2);
  expect(replyRequests).toBe(1);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  await page.waitForTimeout(400);
  expect(await calls(page)).toBe(2);
  expect(await page.evaluate(() => (window as any).__micControls.transcriptions)).toBe(1);
});

test('changing microphone during quiet interruption monitoring releases capture and prevents implicit listening afterward', async ({ page }) => {
  await page.evaluate(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let captures = 0;
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await get(constraints);
      // A real synthetic MediaStream with silent tracks models waiting for the
      // user to interrupt; no onset should occur while we change microphones.
      if (++captures === 2) stream.getAudioTracks().forEach(track => { track.enabled = false; });
      return stream;
    };
  });
  const source = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  const speech = Buffer.from(source.subarray(0, 44 + 16000 * 2 * 3));
  speech.writeUInt32LE(speech.length - 8, 4);
  speech.writeUInt32LE(speech.length - 44, 40);
  await page.route('**/api/chat/stream', route => {
    const text = 'I am listening to your thoughts.';
    return route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', text })}\n` });
  });
  await page.route('**/api/speech', route => route.fulfill({ contentType: 'audio/wav', body: speech, headers: { 'X-Audio-Duration': '3' } }));
  await page.getByRole('combobox', { name: 'Microphone input' }).selectOption('desk-mic');
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await expect.poll(async () => Number(await page.locator('#mic-meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  await page.locator('#conversation-start').click();
  await expect.poll(() => calls(page)).toBe(2);
  await expect(page.locator('#mic-state')).toHaveText('Listening for interruption');
  await page.getByRole('combobox', { name: 'Microphone input' }).selectOption('usb-mic');
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'speaking');
  await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(600);
  expect(await calls(page)).toBe(2);
  expect(await page.evaluate(() => (window as any).__micControls.transcriptions)).toBe(1);
  await expect(page.getByRole('combobox', { name: 'Microphone input' })).toHaveValue('usb-mic');
});

test('a delayed conversation summary survives automatic listening for the next voice turn', async ({ page }) => {
  const source = await readFile(new URL('./fixtures/microphone.wav', import.meta.url));
  const speech = Buffer.from(source.subarray(0, 44 + 16000 * 2 * 0.45));
  speech.writeUInt32LE(speech.length - 8, 4);
  speech.writeUInt32LE(speech.length - 44, 40);
  await page.route('**/api/chat/stream', route => {
    const text = 'I understand.';
    return route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', text })}\n` });
  });
  await page.route('**/api/speech', route => route.fulfill({ contentType: 'audio/wav', body: speech, headers: { 'X-Audio-Duration': '0.45' } }));
  let releaseSummary: (() => void) | undefined;
  await page.route('**/api/chat/summary', async route => {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 15000);
      releaseSummary = () => { clearTimeout(timer); resolve(); };
    });
    await route.fulfill({ json: { summary: 'We discussed five earlier topics and kept their context.' } }).catch(() => {});
  });
  await page.locator('#conversation-interrupt').uncheck();
  for (let turn = 1; turn <= 5; turn++) {
    await page.getByRole('textbox', { name: 'Message Milo' }).fill(`We discussed topic ${turn}.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.conversation-message.assistant')).toHaveCount(turn);
    await expect(page.locator('#conversation-panel')).toHaveAttribute('data-state', 'idle');
  }
  expect(await calls(page)).toBe(0);
  await page.locator('#conversation-start').click();
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  await expect.poll(async () => Number(await page.locator('#mic-meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  await page.locator('#conversation-start').click();
  await expect.poll(() => Boolean(releaseSummary)).toBe(true);
  await expect.poll(() => calls(page)).toBe(2);
  await expect(page.locator('#mic-state')).toHaveText('Listening');
  releaseSummary!();
  await expect(page.locator('#memory-detail')).toContainText('We discussed five earlier topics and kept their context.');
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect.poll(() => allTracksEnded(page)).toBe(true);
});

test('permission action reveals microphones, releases discovery tracks, and uses the selected input', async ({page}, testInfo) => {
  await page.evaluate(()=>{(window as any).__micControls.requirePermission=true;});
  await page.getByRole('button',{name:'Refresh microphones'}).click();
  await expect(page.locator('#mic-device option')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Allow microphone access'})).toBeVisible();
  expect(await calls(page)).toBe(0);
  await page.getByRole('button',{name:'Allow microphone access'}).click();
  await expect(page.locator('#mic-device option')).toHaveCount(3);
  await expect.poll(()=>allTracksEnded(page)).toBe(true);
  expect(await page.evaluate(()=>(window as any).__micControls.calls[0])).toEqual({audio:true,video:false});
  await page.getByRole('combobox',{name:'Microphone input'}).selectOption('usb-mic');
  await page.getByRole('button',{name:'Refresh microphones'}).click();
  await expect(page.getByRole('combobox',{name:'Microphone input'})).toHaveValue('usb-mic');
  expect(await calls(page)).toBe(1);
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('tab',{name:'Setup',exact:true}).click();
  await page.locator('.mic-controls').screenshot({path:testInfo.outputPath('microphone-selection-mobile.png')});
  await page.setViewportSize({width:1440,height:1024});
  await page.getByRole('button',{name:'Start conversation',exact:true}).click();
  await expect.poll(()=>calls(page)).toBe(2);
  expect(await page.evaluate(()=>(window as any).__micControls.calls[1].audio.deviceId)).toEqual({exact:'usb-mic'});
  await page.getByRole('button',{name:'Mute microphone',exact:true}).click();
  await expect.poll(()=>allTracksEnded(page)).toBe(true);
});

test('blocked microphone discovery gives recovery and a later permission grant succeeds', async ({page}) => {
  await page.evaluate(()=>{Object.assign((window as any).__micControls,{requirePermission:true,denyPermission:true});});
  await page.getByRole('button',{name:'Refresh microphones'}).click();
  await page.getByRole('button',{name:'Allow microphone access'}).click();
  await expect(page.locator('#mic-selection-status')).toContainText('browser site settings');
  expect(await page.evaluate(()=>(window as any).__micControls.tracks.length)).toBe(0);
  await page.evaluate(()=>{(window as any).__micControls.denyPermission=false;});
  await page.getByRole('button',{name:'Allow microphone access'}).click();
  await expect(page.locator('#mic-device option')).toHaveCount(3);
  await expect.poll(()=>allTracksEnded(page)).toBe(true);
});

test('leaving while discovery permission is pending releases the late stream without recording', async ({page}) => {
  await page.evaluate(()=>{Object.assign((window as any).__micControls,{requirePermission:true,holdPermission:true});});
  await page.getByRole('button',{name:'Refresh microphones'}).click();
  await page.getByRole('button',{name:'Allow microphone access'}).click();
  await expect.poll(()=>page.evaluate(()=>!!(window as any).__micControls.releasePermission)).toBe(true);
  await page.getByRole('tab',{name:'Sentence studio'}).click();
  await page.evaluate(()=>{(window as any).__micControls.releasePermission();});
  await expect.poll(()=>allTracksEnded(page)).toBe(true);
  expect(await page.evaluate(()=>(window as any).__micControls.transcriptions)).toBe(0);
});

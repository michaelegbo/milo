import { test, expect } from '@playwright/test';

test('interruption capture ignores spikes, retains opening speech after a long wait, and closes after silence', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MicrophoneRecorder } = await import('/src/microphone.ts');
    let port: { onmessage?: (event: { data: { type: string; samples?: Float32Array } }) => void };
    let stopped = 0, closed = 0, started = 0, onset = 0;
    const errors: string[] = [];
    let completed: Blob | undefined;
    const track = { stop() { stopped++; }, addEventListener() {}, removeEventListener() {} };
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream;
    const node = () => ({ connect() {}, disconnect() {} });
    (window as any).AudioContext = class {
      sampleRate = 16000; state = 'running'; destination = {};
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return node(); }
      createGain() { return { ...node(), gain: { value: 0 } }; }
      async resume() {}
      async close() { this.state = 'closed'; closed++; }
    };
    (window as any).AudioWorkletNode = class {
      onprocessorerror = null;
      port = { onmessage: undefined as any, close() {}, postMessage: () => queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } })) };
      constructor() { port = this.port; }
      connect() {} disconnect() {}
    };
    const recorder = new MicrophoneRecorder();
    await recorder.start({ waitForSpeech: true, onStarted: () => started++, onSpeechStart: () => onset++, onError: (message: string) => errors.push(message), onComplete: (wav: Blob) => { completed = wav; } });
    const feed = (seconds: number, amplitude: number) => {
      for (let frame = 0; frame < Math.round(seconds * 50); frame++) port.onmessage?.({ data: { type: 'samples', samples: new Float32Array(320).fill(amplitude) } });
    };
    feed(25, 0);
    const waitingAfter25Seconds = recorder.active;
    feed(0.10, 0.12); feed(0.10, 0); feed(0.12, 0.12); feed(0.10, 0);
    const spikesTriggered = onset;
    feed(0.20, 0.12);
    const sustainedTriggered = onset;
    // After onset, softer speech below the interruption threshold stays in the turn.
    feed(0.40, 0.025); feed(0.94, 0);
    await new Promise(resolve => queueMicrotask(resolve));
    const wav = new DataView(await completed!.arrayBuffer());
    const samples = Array.from({ length: (wav.byteLength - 44) / 2 }, (_, index) => wav.getInt16(44 + index * 2, true) / 32768);
    return { started, waitingAfter25Seconds, spikesTriggered, sustainedTriggered, onset, active: recorder.active, stopped, closed, errors, duration: samples.length / 16000, openingPeak: Math.max(...samples.slice(0, 16000 * 0.5)), softSpeechPresent: samples.some(sample => sample > 0.024 && sample < 0.026) };
  });
  expect(result.started).toBe(1);
  expect(result.waitingAfter25Seconds).toBe(true);
  expect(result.spikesTriggered).toBe(0);
  expect(result.sustainedTriggered).toBe(1);
  expect(result.onset).toBe(1);
  expect(result.errors).toEqual([]);
  expect(result.active).toBe(false);
  expect(result.stopped).toBeGreaterThan(0);
  expect(result.closed).toBe(1);
  expect(result.duration).toBeGreaterThan(1);
  expect(result.duration).toBeLessThan(2);
  expect(result.openingPeak).toBeGreaterThan(0.11);
  expect(result.softSpeechPresent).toBe(true);
});

test('interruption capture has a fresh 20-second limit and cancellation discards monitored audio', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MicrophoneRecorder } = await import('/src/microphone.ts');
    let port: any;
    let stopped = 0, closed = 0, onset = 0;
    const errors: string[] = [];
    const completed: Blob[] = [];
    const track = { stop() { stopped++; }, addEventListener() {}, removeEventListener() {} };
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream;
    const node = () => ({ connect() {}, disconnect() {} });
    (window as any).AudioContext = class {
      sampleRate = 16000; state = 'running'; destination = {};
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return node(); }
      createGain() { return { ...node(), gain: { value: 0 } }; }
      async resume() {}
      async close() { this.state = 'closed'; closed++; }
    };
    (window as any).AudioWorkletNode = class {
      onprocessorerror = null;
      port = { onmessage: undefined as any, close() {}, postMessage: () => queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } })) };
      constructor() { port = this.port; }
      connect() {} disconnect() {}
    };
    const recorder = new MicrophoneRecorder();
    const options = { waitForSpeech: true, onSpeechStart: () => onset++, onError: (message: string) => errors.push(message), onComplete: (wav: Blob) => { completed.push(wav); } };
    const feed = (seconds: number, amplitude: number) => {
      for (let frame = 0; frame < Math.round(seconds * 50); frame++) port.onmessage?.({ data: { type: 'samples', samples: new Float32Array(320).fill(amplitude) } });
    };
    await recorder.start(options);
    feed(25, 0); feed(25, 0.12);
    await new Promise(resolve => queueMicrotask(resolve));
    const duration = ((await completed[0].arrayBuffer()).byteLength - 44) / 2 / 16000;
    await recorder.start(options);
    feed(25, 0); feed(0.1, 0.12);
    recorder.cancel();
    feed(1, 0.12); feed(1, 0);
    await new Promise(resolve => queueMicrotask(resolve));
    return { duration, onset, completed: completed.length, active: recorder.active, stopped, closed, errors };
  });
  expect(result.duration).toBe(20);
  expect(result.onset).toBe(1);
  expect(result.completed).toBe(1);
  expect(result.active).toBe(false);
  expect(result.stopped).toBeGreaterThanOrEqual(2);
  expect(result.closed).toBe(2);
  expect(result.errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { SpeechPlayer } from '../src/speech';
import { encodeWav } from '../src/microphone';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class TestBuffer {
  readonly samples: Float32Array;
  constructor(readonly length: number, readonly sampleRate: number) { this.samples = new Float32Array(length); }
  get duration() { return this.length / this.sampleRate; }
  getChannelData() { return this.samples; }
}

/** Deterministic audio-graph fixture: no speaker or physical microphone is used. */
function audioHarness() {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  let downloaded: Blob | undefined;
  const requests: { text: string; signal: AbortSignal }[] = [];
  const clips = new Map<string, ArrayBuffer>();
  let handleRequest: ((text: string, signal: AbortSignal) => Promise<Response>) | undefined;
  class TestSource {
    buffer!: TestBuffer;
    onended?: () => void;
    offset = 0;
    startedAt = 0;
    stopped = false;
    disconnected = false;
    connect() {}
    disconnect() { this.disconnected = true; }
    start(_when: number, offset: number) { this.offset = offset; this.startedAt = context.currentTime; }
    stop() { this.stopped = true; }
    end() {
      context.currentTime = this.startedAt + this.buffer.duration - this.offset;
      this.onended?.();
    }
  }
  const context = {
    currentTime: 0,
    state: 'running',
    destination: {},
    sources: [] as TestSource[],
    async resume() {},
    async close() { this.state = 'closed'; },
    createAnalyser() {
      return { fftSize: 512, frequencyBinCount: 256, smoothingTimeConstant: 0, connect() {},
        getByteTimeDomainData(array: Uint8Array) { array.fill(140); },
        getByteFrequencyData(array: Uint8Array) { array.fill(50); } };
    },
    createBuffer(_channels: number, length: number, sampleRate: number) { return new TestBuffer(length, sampleRate); },
    createBufferSource() { const source = new TestSource(); this.sources.push(source); return source; },
    async decodeAudioData(data: ArrayBuffer) {
      const view = new DataView(data);
      const buffer = new TestBuffer((data.byteLength - 44) / 2, view.getUint32(24, true));
      for (let i = 0; i < buffer.length; i++) buffer.samples[i] = view.getInt16(44 + i * 2, true) / 32768;
      return buffer;
    },
  };
  replace('AudioContext', class { constructor() { return context; } });
  replace('window', { setTimeout, clearTimeout });
  replace('document', { createElement: () => ({ href: '', download: '', click() {} }) });
  replace('fetch', async (_url: string, init: RequestInit) => {
    const text = JSON.parse(init.body as string).text;
    const signal = init.signal as AbortSignal;
    requests.push({ text, signal });
    if (handleRequest) return handleRequest(text, signal);
    return new Response(clips.get(text), { headers: { 'Content-Type': 'audio/wav' } });
  });
  const originalCreateURL = URL.createObjectURL;
  URL.createObjectURL = blob => { downloaded = blob as Blob; return 'blob:test-stream'; };
  const player = new SpeechPlayer();
  return {
    player, context, clips, requests,
    setFetch(handler: typeof handleRequest) { handleRequest = handler; },
    async addClip(text: string, seconds: number, level: number) {
      clips.set(text, await encodeWav(new Float32Array(Math.round(seconds * 24000)).fill(level), 24000).arrayBuffer());
    },
    get downloaded() { return downloaded; },
    dispose() {
      player.dispose();
      URL.createObjectURL = originalCreateURL;
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('streams first audio before the reply ends and appends each segment once into the complete WAV', async () => {
  const h = audioHarness();
  const nextSentence = deferred<void>();
  let iterableFinished = false;
  async function* sentences() {
    yield 'First sentence.';
    await nextSentence.promise;
    yield 'Second sentence.';
    iterableFinished = true;
  }
  try {
    await h.addClip('First sentence.', 0.5, 0.2);
    await h.addClip('Second sentence.', 0.25, 0.4);
    const operation = h.player.speakStream(sentences(), 'am_michael', 1);
    await expect.poll(() => h.player.state).toBe('playing');
    expect(iterableFinished).toBe(false);
    expect(h.player.streaming).toBe(true);
    expect(h.context.sources).toHaveLength(1);
    expect(h.context.sources[0].offset).toBe(0);
    nextSentence.resolve();
    await operation;
    expect(h.player.duration).toBeCloseTo(0.75);
    expect(h.player.streaming).toBe(false);
    expect(h.requests.map(request => request.text)).toEqual(['First sentence.', 'Second sentence.']);
    // The first source retains its original buffer; the next starts at its end.
    h.context.sources[0].end();
    expect(h.context.sources).toHaveLength(2);
    expect(h.context.sources[1].offset).toBeCloseTo(0.5);
    expect(h.context.sources[1].buffer.duration).toBeCloseTo(0.75);
    h.context.sources[1].end();
    expect(h.player.state).toBe('idle');
    expect(h.player.currentTime).toBeCloseTo(0.75);
    h.player.download();
    const wav = new DataView(await h.downloaded!.arrayBuffer());
    expect(wav.byteLength).toBe(44 + 18000 * 2);
    expect(wav.getUint32(24, true)).toBe(24000);
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getInt16(44 + 11999 * 2, true) / 32768).toBeCloseTo(0.2, 3);
    expect(wav.getInt16(44 + 12000 * 2, true) / 32768).toBeCloseTo(0.4, 3);
    expect(wav.getInt16(wav.byteLength - 2, true) / 32768).toBeCloseTo(0.4, 3);
  } finally { nextSentence.resolve(); h.dispose(); }
});

test('a gap between sentences waits, then starts only the unplayed appended samples', async () => {
  const h = audioHarness();
  const nextSentence = deferred<void>();
  async function* sentences() { yield 'One.'; await nextSentence.promise; yield 'Two.'; }
  try {
    await h.addClip('One.', 0.2, 0.2); await h.addClip('Two.', 0.3, 0.4);
    const operation = h.player.speakStream(sentences(), 'am_michael', 1);
    await expect.poll(() => h.player.state).toBe('playing');
    h.context.sources[0].end();
    expect(h.player.state).toBe('generating');
    expect(h.player.getAudio().speaking).toBe(false);
    nextSentence.resolve(); await operation;
    expect(h.context.sources).toHaveLength(2);
    expect(h.context.sources[1].offset).toBeCloseTo(0.2);
    h.context.sources[1].end();
    expect(h.player.state).toBe('idle');
    expect(h.player.duration).toBeCloseTo(0.5);
  } finally { nextSentence.resolve(); h.dispose(); }
});

test('pause holds while later sentences arrive and resume uses the exact paused offset', async () => {
  const h = audioHarness();
  const nextSentence = deferred<void>();
  async function* sentences() { yield 'One.'; await nextSentence.promise; yield 'Two.'; }
  try {
    await h.addClip('One.', 0.5, 0.2); await h.addClip('Two.', 0.25, 0.4);
    const operation = h.player.speakStream(sentences(), 'am_michael', 1);
    await expect.poll(() => h.player.state).toBe('playing');
    h.context.currentTime = 0.2;
    h.player.pause();
    expect(h.player.state).toBe('paused');
    expect(h.context.sources[0].stopped).toBe(true);
    nextSentence.resolve(); await operation;
    expect(h.player.state).toBe('paused');
    expect(h.context.sources).toHaveLength(1);
    expect(h.player.currentTime).toBeCloseTo(0.2);
    await h.player.resume();
    expect(h.context.sources).toHaveLength(2);
    expect(h.context.sources[1].offset).toBeCloseTo(0.2);
    h.context.sources[1].end();
    expect(h.player.state).toBe('idle');
    expect(h.player.currentTime).toBeCloseTo(0.75);
  } finally { nextSentence.resolve(); h.dispose(); }
});

test('stop rejects late segment playback and late onended callbacks without replacing state', async () => {
  const h = audioHarness();
  const delayed = deferred<Response>();
  async function* sentences() { yield 'One.'; yield 'Two.'; }
  try {
    await h.addClip('One.', 0.5, 0.2); await h.addClip('Two.', 0.25, 0.4);
    h.setFetch(async text => text === 'Two.' ? delayed.promise : new Response(h.clips.get(text)));
    const operation = h.player.speakStream(sentences(), 'am_michael', 1);
    await expect.poll(() => h.requests.length).toBe(2);
    expect(h.player.state).toBe('playing');
    h.player.stop();
    expect(h.requests[1].signal.aborted).toBe(true);
    expect(h.context.sources[0].stopped).toBe(true);
    delayed.resolve(new Response(h.clips.get('Two.')));
    await operation;
    h.context.sources[0].end();
    expect(h.player.state).toBe('idle');
    expect(h.player.currentTime).toBe(0);
    expect(h.player.streaming).toBe(false);
    expect(h.context.sources).toHaveLength(1);
    expect(h.player.duration).toBeCloseTo(0.5);
  } finally { delayed.resolve(new Response(h.clips.get('Two.'))); h.dispose(); }
});

test('a failed later sentence stops audio and preserves the readable error', async () => {
  const h = audioHarness();
  async function* sentences() { yield 'One.'; yield 'Two.'; }
  try {
    await h.addClip('One.', 0.5, 0.2);
    h.setFetch(async text => text === 'Two.' ? new Response(JSON.stringify({ message: 'The voice is unavailable.' }), { status: 503 }) : new Response(h.clips.get(text)));
    await h.player.speakStream(sentences(), 'am_michael', 1);
    expect(h.player.state).toBe('error');
    expect(h.player.error).toBe('The voice is unavailable.');
    expect(h.player.streaming).toBe(false);
    expect(h.context.sources[0].stopped).toBe(true);
    h.context.sources[0].end();
    expect(h.player.state).toBe('error');
  } finally { h.dispose(); }
});

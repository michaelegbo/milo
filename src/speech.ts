import { apiFetch } from './transport';
import { isDeviceOnly } from './deployment';
import { encodeWav, resampleAudio } from './microphone';
import { PCM_TYPE } from './voice-provider';
export type PlaybackState = 'idle' | 'generating' | 'playing' | 'paused' | 'error';

/** Sentence-sized chunks with a short opening chunk, so playback starts before the rest is generated. */
export function splitSpeechText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(clean), part => part.segment.trim()).filter(Boolean)
    : clean.split(/(?<=[.!?…]["”’)]*)\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    // No single request waits on a paragraph; long sentences break at a space.
    while (rest.length > 180) { const at = rest.lastIndexOf(' ', 180); const end = at > 0 ? at : 180; chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim(); }
    if (rest) chunks.push(rest);
  }
  // Open with a clause of three to eight words when the first sentence is long,
  // so the first audio arrives while the remainder is still being generated.
  const first = chunks[0];
  if (first) {
    const clause = /^((?:\S+\s+){2,7}\S+[,;:—–])\s+(\S.*)$/.exec(first);
    if (clause && clause[1].length < first.length * 0.7) chunks.splice(0, 1, clause[1], clause[2]);
  }
  return chunks;
}

export class SpeechPlayer {
  state: PlaybackState = 'idle';
  error = '';
  duration = 0;
  waveform: number[] = Array(64).fill(0.08);
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private samples?: Uint8Array<ArrayBuffer>;
  private spectrum?: Uint8Array<ArrayBuffer>;
  private source?: AudioBufferSourceNode;
  private retiring?: AudioBufferSourceNode;
  private handoff?: number;
  private playsUntil = 0;
  private buffer?: AudioBuffer;
  private request?: AbortController;
  private generation = 0;
  private started = 0;
  private offset = 0;
  private exported?: Blob;
  private streamOpen = false;
  onChange: () => void = () => {};

  get currentTime() {
    return Math.max(0, Math.min(this.duration, this.state === 'playing' && this.context
      ? this.offset + this.context.currentTime - this.started : this.offset));
  }

  get hasAudio() { return !!this.buffer && this.duration > 0; }

  private static waveformOf(samples: Float32Array) {
    const step = Math.max(1, Math.floor(samples.length / 64));
    return Array.from({ length: 64 }, (_, i) => {
      let energy = 0, count = 0;
      for (let j = i * step; j < Math.min((i + 1) * step, samples.length); j += 12) { energy += samples[j] ** 2; count++; }
      return Math.max(0.06, Math.min(1, Math.sqrt(energy / Math.max(1, count)) * 6));
    });
  }

  /** Take a decoded clip as the current audio. */
  private adopt(buffer: AudioBuffer) {
    this.buffer = buffer; this.duration = buffer.duration;
    this.waveform = SpeechPlayer.waveformOf(buffer.getChannelData(0));
    this.exported = undefined;
  }

  /** Append samples to the current audio and start playing if nothing is playing. */
  private append(samples: Float32Array, sampleRate: number) {
    const previous = this.buffer;
    const rate = previous?.sampleRate ?? sampleRate;
    const added = rate === sampleRate ? samples : resampleAudio(samples, sampleRate, rate);
    const combined = this.context!.createBuffer(1, (previous?.length ?? 0) + added.length, rate);
    const all = combined.getChannelData(0);
    if (previous) all.set(previous.getChannelData(0));
    all.set(added, previous?.length ?? 0);
    this.buffer = combined; this.duration = combined.duration;
    this.waveform = SpeechPlayer.waveformOf(all);
    this.exported = undefined;
    if (!this.source && this.state !== 'paused') this.play();
    else this.onChange();
  }

  private appendPcm(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    this.append(samples, 24000);
  }

  /** Play a pre-rendered clip. Resolves false when it is unavailable so the caller can generate instead. */
  async speakClip(url: string): Promise<boolean> {
    this.stop(true);
    const id = ++this.generation;
    this.state = 'generating'; this.error = ''; this.onChange();
    const request = new AbortController();
    this.request = request;
    try {
      await this.initialize();
      if (id !== this.generation) return true;
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) throw new Error(`Clip unavailable (${response.status}).`);
      const buffer = await this.context!.decodeAudioData(await response.arrayBuffer());
      if (id !== this.generation) return true;
      this.adopt(buffer);
      this.offset = 0;
      this.play();
      return true;
    } catch {
      // Stopped, superseded, or missing: never surface an error for an optional clip.
      return id !== this.generation || request.signal.aborted;
    } finally {
      if (id === this.generation) this.request = undefined;
    }
  }
  get streaming() { return this.streamOpen; }

  /** Resume audio inside a user gesture before a microphone or text turn. */
  async unlock() { await this.initialize(); }

  private async initialize() {
    this.context ??= new AudioContext();
    if (!this.analyser) {
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.55;
      this.analyser.connect(this.context.destination);
      this.samples = new Uint8Array(this.analyser.fftSize);
      this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);
    }
    await this.context.resume();
  }

  async speak(text: string, voice: string, speed: number) {
    this.stop(true);
    const id = ++this.generation;
    this.state = 'generating';
    this.error = '';
    this.onChange();
    const request = new AbortController();
    this.request = request;
    const timeout = window.setTimeout(() => request.abort('timeout'), isDeviceOnly ? 20 * 60_000 : 180_000);
    try {
      await this.initialize();
      if (id !== this.generation) return;
      const response = await apiFetch('/api/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }), signal: request.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || 'The voice could not be generated. Please try again.');
      }
      const wav = await response.blob();
      const buffer = await this.context!.decodeAudioData(await wav.arrayBuffer());
      if (id !== this.generation) return;
      this.buffer = buffer;
      this.duration = buffer.duration;
      this.exported = undefined;
      const data = buffer.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / 64));
      this.waveform = Array.from({ length: 64 }, (_, i) => {
        let energy = 0;
        let count = 0;
        for (let j = i * step; j < Math.min((i + 1) * step, data.length); j += 12) {
          energy += data[j] * data[j]; count++;
        }
        return Math.max(0.06, Math.min(1, Math.sqrt(energy / Math.max(count, 1)) * 6));
      });
      this.offset = 0;
      this.play();
    } catch (error) {
      if (id !== this.generation) return;
      this.state = 'error';
      this.error = request.signal.aborted ? 'That took too long. Try a shorter sentence or try again.'
        : error instanceof TypeError ? isDeviceOnly ? 'The voice could not run in this browser. Free some memory and try loading it again above.' : 'Cannot reach the local voice. Start the app with npm run dev, then try again.'
        : error instanceof Error ? error.message : 'Something went wrong. Please try again.';
      this.onChange();
    } finally {
      window.clearTimeout(timeout);
      if (id === this.generation) this.request = undefined;
    }
  }

  /** Start a source for the current buffer at this.offset, now or at a scheduled context time. */
  private play(when?: number) {
    if (!this.buffer || !this.context || !this.analyser) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    const playsUntil = this.buffer.duration;
    source.connect(this.analyser);
    source.onended = () => {
      source.disconnect();
      if (this.source !== source) return;
      this.source = undefined; this.clearHandoff();
      this.offset = playsUntil;
      if (this.duration > this.offset + 0.001) { this.play(); return; }
      this.state = this.streamOpen ? 'generating' : 'idle';
      this.onChange();
    };
    this.source = source;
    this.playsUntil = playsUntil;
    this.started = when ?? this.context.currentTime;
    this.state = 'playing';
    source.start(when ?? 0, this.offset);
    this.scheduleHandoff();
    this.onChange();
  }

  /**
   * Streamed audio arrives while a source is already playing a snapshot of the
   * buffer. Restarting when that snapshot ends leaves a gap at every chunk, which
   * sounds like a dragging buzz. Instead, shortly before the end, a successor
   * holding the newly appended audio is scheduled to begin at the exact sample
   * where this one stops, so chunks join without a click.
   */
  private scheduleHandoff() {
    this.clearHandoff();
    if (!this.context || !this.source) return;
    const endsAt = this.started + (this.playsUntil - this.offset);
    const wait = Math.max(0, (endsAt - this.context.currentTime) * 1000 - 80);
    this.handoff = window.setTimeout(() => {
      this.handoff = undefined;
      const current = this.source;
      if (!current || !this.context || this.state !== 'playing' || !this.buffer) return;
      const boundary = this.started + (this.playsUntil - this.offset);
      // Too late (the source already ended and restarted) or nothing new: leave it to onended.
      if (boundary <= this.context.currentTime || this.buffer.duration <= this.playsUntil + 0.001) return;
      current.onended = () => { current.disconnect(); if (this.retiring === current) this.retiring = undefined; };
      this.retiring?.stop(); this.retiring?.disconnect();
      this.retiring = current;
      this.offset = this.playsUntil;
      this.play(boundary);
    }, wait);
  }

  private clearHandoff() {
    if (this.handoff !== undefined) { clearTimeout(this.handoff); this.handoff = undefined; }
  }

  private silence() {
    this.clearHandoff();
    const source = this.source, retiring = this.retiring;
    this.source = undefined; this.retiring = undefined;
    for (const node of [source, retiring]) { try { node?.stop(); } catch { /* Never started or already stopped. */ } node?.disconnect(); }
  }

  /** Play completed sentences while the rest of the response is still arriving. */
  async speakStream(sentences: AsyncIterable<string> | Iterable<string>, voice: string, speed: number) {
    this.stop(true);
    const id = ++this.generation;
    const request = new AbortController();
    this.request = request;
    this.streamOpen = true;
    this.state = 'generating'; this.onChange();
    const timeout = window.setTimeout(() => request.abort('timeout'), isDeviceOnly ? 20 * 60_000 : 180_000);
    try {
      await this.initialize();
      for await (const text of sentences) {
        if (id !== this.generation) return;
        const response = await apiFetch('/api/speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }), signal: request.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || 'The next part could not be spoken. Please try again.');
        }
        if ((response.headers.get('content-type') || '').startsWith(PCM_TYPE) && response.body) {
          // 16-bit little-endian mono at 24 kHz, appended as it streams in, so the
          // first words play while the rest of the sentence is still being made.
          const reader = response.body.getReader();
          let carry = new Uint8Array(0);
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (id !== this.generation) return;
              if (value?.length) {
                const bytes = new Uint8Array(carry.length + value.length);
                bytes.set(carry); bytes.set(value, carry.length);
                const usable = bytes.length - bytes.length % 2;
                if (usable >= 9600 || done) { this.appendPcm(bytes.subarray(0, usable)); carry = bytes.slice(usable); }
                else carry = bytes;
              }
              if (done) break;
            }
            if (carry.length >= 2) this.appendPcm(carry.subarray(0, carry.length - carry.length % 2));
          } finally { reader.releaseLock(); }
        } else {
          const chunk = await this.context!.decodeAudioData(await response.arrayBuffer());
          if (id !== this.generation) return;
          this.append(chunk.getChannelData(0), chunk.sampleRate);
        }
      }
      if (id !== this.generation) return;
      this.streamOpen = false;
      if (!this.source && (this.state as PlaybackState) !== 'paused') {
        if (this.buffer && this.offset < this.duration - 0.001) this.play();
        else { this.state = 'idle'; this.onChange(); }
      }
    } catch (error) {
      if (id !== this.generation) return;
      this.silence();
      this.streamOpen = false;
      this.state = 'error';
      this.error = request.signal.aborted ? 'That took too long. Try a shorter sentence or try again.' : error instanceof Error ? error.message : 'Milo could not finish speaking.';
      this.onChange();
    } finally {
      clearTimeout(timeout);
      if (id === this.generation) this.request = undefined;
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.offset = this.currentTime;
    this.silence();
    this.state = 'paused';
    this.onChange();
  }

  async resume() {
    if (this.state !== 'paused') return;
    const id = this.generation;
    try {
      await this.initialize();
      if (id === this.generation && this.state === 'paused') this.play();
    } catch {
      this.state = 'error'; this.error = 'Audio is unavailable. Check your audio device and try again.'; this.onChange();
    }
  }

  stop(clear = false) {
    this.generation++;
    this.streamOpen = false;
    this.request?.abort();
    this.request = undefined;
    this.silence();
    this.offset = 0;
    this.state = 'idle';
    this.error = '';
    if (clear) { this.exported = undefined; this.buffer = undefined; this.duration = 0; this.waveform = Array(64).fill(0.08); }
    this.onChange();
  }

  getAudio() {
    if (this.state !== 'playing' || !this.analyser || !this.samples || !this.spectrum)
      return { level: 0, bands: [0, 0, 0], speaking: false };
    this.analyser.getByteTimeDomainData(this.samples);
    this.analyser.getByteFrequencyData(this.spectrum);
    let energy = 0;
    for (const sample of this.samples) energy += ((sample - 128) / 128) ** 2;
    const bands = [0, 0, 0];
    const boundaries = [0, 12, 40, 110];
    for (let band = 0; band < 3; band++) {
      for (let i = boundaries[band]; i < boundaries[band + 1]; i++) bands[band] += this.spectrum[i] / 255;
      bands[band] /= boundaries[band + 1] - boundaries[band];
    }
    return { level: Math.min(1, Math.sqrt(energy / this.samples.length) * 4.5), bands, speaking: true };
  }

  /** Encode the current audio as 24 kHz mono WAV on demand, once per clip. */
  exportWav(): Blob | undefined {
    if (!this.buffer || !this.duration) return undefined;
    return this.exported ??= encodeWav(resampleAudio(this.buffer.getChannelData(0), this.buffer.sampleRate, 24000), 24000);
  }

  download() {
    const wav = this.exportWav();
    if (!wav) return;
    const url = URL.createObjectURL(wav);
    const a = document.createElement('a');
    a.href = url; a.download = 'milo-speech.wav'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  dispose() { this.stop(); void this.context?.close(); }
}

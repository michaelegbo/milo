import { encodeWav, resampleAudio } from './microphone';
export type PlaybackState = 'idle' | 'generating' | 'playing' | 'paused' | 'error';

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
  private buffer?: AudioBuffer;
  private request?: AbortController;
  private generation = 0;
  private started = 0;
  private offset = 0;
  private wav?: Blob;
  private streamOpen = false;
  onChange: () => void = () => {};

  get currentTime() {
    return Math.min(this.duration, this.state === 'playing' && this.context
      ? this.offset + this.context.currentTime - this.started : this.offset);
  }

  get hasAudio() { return !!this.wav; }
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
    const timeout = window.setTimeout(() => request.abort('timeout'), 180_000);
    try {
      await this.initialize();
      if (id !== this.generation) return;
      const response = await fetch('/api/speech', {
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
      this.wav = wav;
      this.buffer = buffer;
      this.duration = buffer.duration;
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
        : error instanceof TypeError ? 'Cannot reach the local voice. Start the app with npm run dev, then try again.'
        : error instanceof Error ? error.message : 'Something went wrong. Please try again.';
      this.onChange();
    } finally {
      window.clearTimeout(timeout);
      if (id === this.generation) this.request = undefined;
    }
  }

  private play() {
    if (!this.buffer || !this.context || !this.analyser) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    const playsUntil = this.buffer.duration;
    source.connect(this.analyser);
    source.onended = () => {
      source.disconnect();
      if (this.source !== source) return;
      this.source = undefined;
      this.offset = playsUntil;
      if (this.duration > this.offset + 0.001) { this.play(); return; }
      this.state = this.streamOpen ? 'generating' : 'idle';
      this.onChange();
    };
    this.source = source;
    this.started = this.context.currentTime;
    this.state = 'playing';
    source.start(0, this.offset);
    this.onChange();
  }

  /** Play completed sentences while the rest of the response is still arriving. */
  async speakStream(sentences: AsyncIterable<string>, voice: string, speed: number) {
    this.stop(true);
    const id = ++this.generation;
    const request = new AbortController();
    this.request = request;
    this.streamOpen = true;
    this.state = 'generating'; this.onChange();
    const timeout = window.setTimeout(() => request.abort('timeout'), 180_000);
    try {
      await this.initialize();
      for await (const text of sentences) {
        if (id !== this.generation) return;
        const response = await fetch('/api/speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }), signal: request.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || 'The next part of the reply could not be spoken.');
        }
        const chunk = await this.context!.decodeAudioData(await response.arrayBuffer());
        if (id !== this.generation) return;
        const previous = this.buffer;
        const combined = this.context!.createBuffer(1, (previous?.length ?? 0) + chunk.length, chunk.sampleRate);
        const samples = combined.getChannelData(0);
        if (previous) samples.set(previous.getChannelData(0));
        samples.set(chunk.getChannelData(0), previous?.length ?? 0);
        this.buffer = combined; this.duration = combined.duration;
        this.wav = encodeWav(resampleAudio(samples, combined.sampleRate, 24000), 24000);
        this.waveform = Array.from({ length: 64 }, (_, i) => {
          const step = Math.max(1, Math.floor(samples.length / 64));
          let energy = 0, count = 0;
          for (let j = i * step; j < Math.min((i + 1) * step, samples.length); j += 12) { energy += samples[j] ** 2; count++; }
          return Math.max(0.06, Math.min(1, Math.sqrt(energy / Math.max(1, count)) * 6));
        });
        if (!this.source && (this.state as PlaybackState) !== 'paused') this.play();
        else this.onChange();
      }
      if (id !== this.generation) return;
      this.streamOpen = false;
      if (!this.source && (this.state as PlaybackState) !== 'paused') {
        if (this.buffer && this.offset < this.duration - 0.001) this.play();
        else { this.state = 'idle'; this.onChange(); }
      }
    } catch (error) {
      if (id !== this.generation) return;
      const source = this.source; this.source = undefined;
      source?.stop(); source?.disconnect();
      this.streamOpen = false;
      this.state = 'error';
      this.error = request.signal.aborted ? 'That reply took too long. Please try again.' : error instanceof Error ? error.message : 'Milo could not finish the reply.';
      this.onChange();
    } finally {
      clearTimeout(timeout);
      if (id === this.generation) this.request = undefined;
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.offset = this.currentTime;
    const source = this.source;
    this.source = undefined;
    source?.stop();
    source?.disconnect();
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
    const source = this.source;
    this.source = undefined;
    source?.stop(); source?.disconnect();
    this.offset = 0;
    this.state = 'idle';
    this.error = '';
    if (clear) { this.wav = undefined; this.buffer = undefined; this.duration = 0; this.waveform = Array(64).fill(0.08); }
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

  download() {
    if (!this.wav) return;
    const url = URL.createObjectURL(this.wav);
    const a = document.createElement('a');
    a.href = url; a.download = 'milo-speech.wav'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  dispose() { this.stop(); void this.context?.close(); }
}

// Capture only: the output remains silent, and no audio is sent to a speaker.
class MiloAudioRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(512)
    this.used = 0
    this.finished = false
    this.port.onmessage = (event) => {
      if (event.data.type !== 'finish') return
      this.finished = true
      this.flush()
      this.port.postMessage({ type: 'flushed' })
    }
  }

  flush() {
    if (!this.used) return
    const samples = this.used === this.buffer.length ? this.buffer : this.buffer.slice(0, this.used)
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer])
    this.buffer = new Float32Array(512)
    this.used = 0
  }

  process(inputs) {
    if (this.finished) return false
    const channels = inputs[0]
    if (!channels?.length) return true
    // Inspect block length: render quantum size is not guaranteed to stay 128.
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      let mono = 0
      for (const channel of channels) mono += channel[frame] ?? 0
      this.buffer[this.used] = mono / channels.length
      this.used += 1
      if (this.used === this.buffer.length) this.flush()
    }
    return true
  }
}

registerProcessor('milo-audio-recorder', MiloAudioRecorder)

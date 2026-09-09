export interface MicrophoneOptions {
  deviceId?: string
  onStarted?: () => void
  /** Called once a sustained voice onset is detected; capture continues. */
  onSpeechStart?: () => void
  /** Monitor quietly until speech starts, then begin the 20-second turn limit. */
  waitForSpeech?: boolean
  startThreshold?: number
  startSpeechSeconds?: number
  maxInitialSilenceMs?: number
  onLevel?: (level: number) => void
  onComplete: (wav: Blob) => void
  onError: (message: string) => void
}

interface Recording {
  options: MicrophoneOptions
  done: boolean
  finishing: boolean
  context?: AudioContext
  stream?: MediaStream
  source?: MediaStreamAudioSourceNode
  worklet?: AudioWorkletNode
  silentOutput?: GainNode
  timer?: ReturnType<typeof setTimeout>
  initialTimer?: ReturnType<typeof setTimeout>
  flushTimer?: ReturnType<typeof setTimeout>
  rate: number
  frames: number
  voicedFrames: number
  lastVoiceFrame: number
  recordedFrames: number
  preRollFrames: number
  startedSpeech: boolean
  onsetFrames: number
  startThreshold: number
  startSpeechSeconds: number
  chunks: Float32Array[]
  preRoll: Float32Array[]
  pageEnd: () => void
  trackEnded: () => void
}

const MIN_SPEECH_SECONDS = 0.3
const SILENCE_SECONDS = 0.9
const PRE_ROLL_SECONDS = 0.25
const MAX_SECONDS = 20
const VOICE_RMS = 0.012
const NO_SPEECH = 'No speech heard. Move closer to your microphone and try again.'
const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback

/** Average samples when reducing the rate, and interpolate when increasing it. */
export function resampleAudio(input: Float32Array, sourceRate: number, targetRate = 16000): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error('Invalid audio sample rate.')
  }
  if (sourceRate === targetRate) return input.slice()
  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < output.length; i += 1) {
    const start = i * ratio
    if (ratio < 1) {
      const left = Math.floor(start)
      const fraction = start - left
      output[i] = input[left] * (1 - fraction) + input[Math.min(left + 1, input.length - 1)] * fraction
      continue
    }
    const end = Math.min((i + 1) * ratio, input.length)
    let sum = 0
    for (let j = Math.floor(start); j < Math.ceil(end); j += 1) {
      sum += input[j] * (Math.min(j + 1, end) - Math.max(j, start))
    }
    output[i] = sum / (end - start)
  }
  return output
}

export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** A one-turn microphone capture. Nothing is requested until start() is called. */
export class MicrophoneRecorder {
  private recording?: Recording

  get active(): boolean {
    return Boolean(this.recording && !this.recording.done)
  }

  async start(options: MicrophoneOptions): Promise<void> {
    this.cancel()
    const recording: Recording = {
      options,
      done: false,
      finishing: false,
      rate: 16000,
      frames: 0,
      voicedFrames: 0,
      lastVoiceFrame: 0,
      recordedFrames: 0,
      preRollFrames: 0,
      startedSpeech: false,
      onsetFrames: 0,
      startThreshold: bounded(options.startThreshold, 0.045, VOICE_RMS, 0.5),
      startSpeechSeconds: bounded(options.startSpeechSeconds, 0.18, 0.05, 1),
      chunks: [],
      preRoll: [],
      pageEnd: () => this.cancel(),
      trackEnded: () => this.fail(recording, 'Your microphone disconnected. Connect it and try again.'),
    }
    this.recording = recording
    window.addEventListener('pagehide', recording.pageEnd)
    window.addEventListener('beforeunload', recording.pageEnd)
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
        this.fail(recording, 'Microphone capture needs a supported browser on localhost or a secure HTTPS page.')
        return
      }
      const deviceId = options.deviceId?.trim()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      })
      // Permission can resolve after Stop was pressed, or after another turn began.
      if (!this.isCurrent(recording)) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      recording.stream = stream
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', recording.trackEnded))
      const context = new AudioContext({ latencyHint: 'interactive' })
      recording.context = context
      recording.rate = context.sampleRate
      if (!context.audioWorklet) {
        this.fail(recording, 'This browser cannot record microphone audio. Try an up-to-date Chrome, Edge, Firefox, or Safari.')
        return
      }
      await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-recorder.worklet.js`)
      if (!this.isCurrent(recording)) return
      const worklet = new AudioWorkletNode(context, 'milo-audio-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      recording.worklet = worklet
      worklet.onprocessorerror = () => this.fail(recording, 'The microphone stopped recording. Please try again.')
      worklet.port.onmessage = (event: MessageEvent<{ type: string; samples?: Float32Array }>) => {
        if (!this.isCurrent(recording)) return
        if (event.data.type === 'samples' && event.data.samples) this.receive(recording, event.data.samples)
        if (event.data.type === 'flushed' && recording.finishing) this.complete(recording)
      }
      const source = context.createMediaStreamSource(stream)
      const silentOutput = context.createGain()
      silentOutput.gain.value = 0
      recording.source = source
      recording.silentOutput = silentOutput
      source.connect(worklet)
      worklet.connect(silentOutput)
      silentOutput.connect(context.destination)
      await context.resume()
      if (!this.isCurrent(recording) || recording.finishing) return
      recording.options.onStarted?.()
      // UI callbacks may immediately stop or replace this microphone capture.
      if (!this.isCurrent(recording) || recording.finishing) return
      recording.initialTimer = setTimeout(() => {
        if (options.waitForSpeech ? !recording.startedSpeech : recording.voicedFrames < recording.rate * MIN_SPEECH_SECONDS) this.fail(recording, NO_SPEECH)
      }, bounded(options.maxInitialSilenceMs, options.waitForSpeech ? 120000 : 10000, 1000, 120000))
      if (!options.waitForSpeech) recording.timer = setTimeout(() => this.finish(), MAX_SECONDS * 1000)
    } catch (error) {
      if (!this.isCurrent(recording)) return
      const name = error instanceof DOMException ? error.name : ''
      const messages: Record<string, string> = {
        NotAllowedError: 'Microphone access was blocked. Allow the microphone in your browser, then try again.',
        NotFoundError: 'No microphone was found. Connect one and try again.',
        NotReadableError: 'Your microphone is unavailable. Check its connection or close another app using it.',
        OverconstrainedError: 'The selected microphone is unavailable. Choose another microphone and try again.',
        SecurityError: 'The browser blocked microphone access. Open Milo on localhost or a secure HTTPS page.',
      }
      this.fail(recording, messages[name] ?? 'Could not start the microphone. Check your browser permissions and try again.')
    }
  }

  /** Send this turn now. Stops microphone tracks immediately, then flushes the final tiny block. */
  finish(): void {
    const recording = this.recording
    if (!recording || recording.done || recording.finishing) return
    recording.finishing = true
    this.stopTracks(recording)
    recording.source?.disconnect()
    clearTimeout(recording.initialTimer)
    clearTimeout(recording.timer)
    if (!recording.worklet) {
      this.complete(recording)
      return
    }
    recording.flushTimer = setTimeout(() => this.complete(recording), 100)
    recording.worklet.port.postMessage({ type: 'finish' })
  }

  /** Discard this turn without invoking onComplete or onError. */
  cancel(): void {
    const recording = this.recording
    if (!recording || recording.done) return
    recording.done = true
    this.dispose(recording)
  }

  private isCurrent(recording: Recording): boolean {
    return this.recording === recording && !recording.done
  }

  private receive(recording: Recording, samples: Float32Array): void {
    if (!samples.length) return
    let sum = 0
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / samples.length)
    const voiced = rms >= VOICE_RMS
    recording.frames += samples.length
    recording.options.onLevel?.(Math.min(1, rms * 8))
    // An onLevel callback may cancel or replace the recording.
    if (!this.isCurrent(recording)) return

    if (recording.options.waitForSpeech && !recording.startedSpeech) {
      // Monitoring never accumulates a long silent recording. Keep enough
      // context for the onset itself plus a quarter-second of preceding audio.
      this.bufferPreRoll(recording, samples, PRE_ROLL_SECONDS + recording.startSpeechSeconds)
      recording.onsetFrames = rms >= recording.startThreshold ? recording.onsetFrames + samples.length : 0
      if (recording.onsetFrames < recording.rate * recording.startSpeechSeconds || recording.finishing) return
      recording.startedSpeech = true
      recording.voicedFrames = recording.onsetFrames
      recording.lastVoiceFrame = recording.frames
      recording.chunks = recording.preRoll
      recording.recordedFrames = recording.preRollFrames
      recording.preRoll = []
      recording.preRollFrames = 0
      clearTimeout(recording.initialTimer)
      recording.timer = setTimeout(() => this.finish(), MAX_SECONDS * 1000)
      // The owner stops Milo's playback synchronously; the same recording keeps
      // the user's opening words and then uses the normal speech/silence gate.
      recording.options.onSpeechStart?.()
      return
    }

    if (voiced) {
      recording.voicedFrames += samples.length
      recording.lastVoiceFrame = recording.frames
    }
    if (voiced && !recording.startedSpeech) {
      recording.startedSpeech = true
      recording.chunks = recording.preRoll
      recording.recordedFrames = recording.preRollFrames
      recording.preRoll = []
      recording.preRollFrames = 0
      recording.options.onSpeechStart?.()
      if (!this.isCurrent(recording)) return
    }
    if (recording.startedSpeech) {
      const remaining = Math.floor(recording.rate * MAX_SECONDS) - recording.recordedFrames
      if (remaining > 0) {
        const chunk = samples.length <= remaining ? samples : samples.slice(0, remaining)
        recording.chunks.push(chunk)
        recording.recordedFrames += chunk.length
      }
    } else {
      this.bufferPreRoll(recording, samples, PRE_ROLL_SECONDS)
    }
    if (recording.finishing) return
    const enoughSpeech = recording.voicedFrames >= recording.rate * MIN_SPEECH_SECONDS
    const ended = recording.frames - recording.lastVoiceFrame >= recording.rate * SILENCE_SECONDS
    const capturedFrames = recording.options.waitForSpeech ? recording.recordedFrames : recording.frames
    if ((enoughSpeech && ended) || capturedFrames >= recording.rate * MAX_SECONDS) this.finish()
  }

  private bufferPreRoll(recording: Recording, samples: Float32Array, seconds: number): void {
    recording.preRoll.push(samples)
    recording.preRollFrames += samples.length
    const limit = Math.ceil(recording.rate * seconds)
    while (recording.preRollFrames > limit && recording.preRoll.length) {
      const first = recording.preRoll[0]
      const excess = recording.preRollFrames - limit
      if (first.length <= excess) {
        recording.preRoll.shift()
        recording.preRollFrames -= first.length
      } else {
        recording.preRoll[0] = first.slice(excess)
        recording.preRollFrames -= excess
      }
    }
  }

  private complete(recording: Recording): void {
    if (!this.isCurrent(recording)) return
    if (recording.voicedFrames < recording.rate * MIN_SPEECH_SECONDS) {
      this.fail(recording, NO_SPEECH)
      return
    }
    const samples = new Float32Array(recording.recordedFrames)
    let offset = 0
    for (const chunk of recording.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    const wav = encodeWav(resampleAudio(samples, recording.rate))
    recording.done = true
    this.dispose(recording)
    recording.options.onComplete(wav)
  }

  private fail(recording: Recording, message: string): void {
    if (!this.isCurrent(recording)) return
    recording.done = true
    this.dispose(recording)
    recording.options.onError(message)
  }

  private stopTracks(recording: Recording): void {
    recording.stream?.getTracks().forEach((track) => {
      track.removeEventListener('ended', recording.trackEnded)
      track.stop()
    })
  }

  private dispose(recording: Recording): void {
    clearTimeout(recording.timer)
    clearTimeout(recording.initialTimer)
    clearTimeout(recording.flushTimer)
    window.removeEventListener('pagehide', recording.pageEnd)
    window.removeEventListener('beforeunload', recording.pageEnd)
    this.stopTracks(recording)
    recording.source?.disconnect()
    if (recording.worklet) {
      recording.worklet.onprocessorerror = null
      recording.worklet.port.onmessage = null
      recording.worklet.port.close()
      recording.worklet.disconnect()
    }
    recording.silentOutput?.disconnect()
    if (recording.context && recording.context.state !== 'closed') void recording.context.close().catch(() => {})
    recording.chunks = []
    recording.preRoll = []
    if (this.recording === recording) this.recording = undefined
    recording.options.onLevel?.(0)
  }
}

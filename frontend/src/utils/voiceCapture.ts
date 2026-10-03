export const VOICE_SAMPLE_RATE = 16000
export const VOICE_MAX_SECONDS = 20
export const VOICE_MAX_SAMPLES = VOICE_SAMPLE_RATE * VOICE_MAX_SECONDS

/** Average each source interval before downsampling. State spans browser callback boundaries. */
export class Pcm16Encoder {
  private output = new Int16Array(VOICE_MAX_SAMPLES)
  private length = 0
  private sourcePosition = 0
  private total = 0
  private weight = 0
  private nextEdge: number
  private ratio: number
  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate < VOICE_SAMPLE_RATE || sampleRate > 192000) throw new Error('浏览器音频采样率不受支持。')
    this.ratio = sampleRate / VOICE_SAMPLE_RATE
    this.nextEdge = this.ratio
  }
  append(samples: Float32Array): number {
    let energy = 0
    for (const sample of samples) {
      const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
      energy += value * value
      let start = this.sourcePosition, end = start + 1
      while (start < end && this.length < VOICE_MAX_SAMPLES) {
        const edge = Math.min(end, this.nextEdge), part = edge - start
        this.total += value * part; this.weight += part; start = edge
        if (edge >= this.nextEdge - 1e-8) {
          const averaged = Math.max(-1, Math.min(1, this.total / this.weight))
          this.output[this.length++] = Math.round(averaged * (averaged < 0 ? 32768 : 32767))
          this.total = 0; this.weight = 0; this.nextEdge += this.ratio
        }
      }
      this.sourcePosition = end
    }
    return samples.length ? Math.sqrt(energy / samples.length) : 0
  }
  get full(): boolean { return this.length >= VOICE_MAX_SAMPLES }
  get seconds(): number { return this.length / VOICE_SAMPLE_RATE }
  finish(): ArrayBuffer {
    const bytes = new ArrayBuffer(this.length * 2), view = new DataView(bytes)
    for (let index = 0; index < this.length; index++) view.setInt16(index * 2, this.output[index]!, true)
    this.output.fill(0); this.length = 0
    return bytes
  }
  clear(): void { this.output.fill(0); this.length = 0 }
}

const processorSource = `class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) { const frame = inputs[0]?.[0]; if (frame) this.port.postMessage(frame.slice()); return true; }
}; registerProcessor('flowboard-voice-capture', VoiceCapture);`

export class MicrophoneCapture {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | ScriptProcessorNode | null = null
  private sink: GainNode | null = null
  private encoder: Pcm16Encoder | null = null
  private canceled = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private ended: (() => void) | null = null
  private lastMeterTime = 0
  private trackEnded = () => this.onError(new Error('麦克风已断开，请重新录制。'))
  private onMeter: (seconds: number, rms: number) => void
  private onLimit: () => void
  private onError: (error: Error) => void
  constructor(onMeter: (seconds: number, rms: number) => void, onLimit: () => void, onError: (error: Error) => void) { this.onMeter = onMeter; this.onLimit = onLimit; this.onError = onError }
  async start(): Promise<void> {
    if (!window.isSecureContext) throw new Error('麦克风需要 HTTPS，请通过网站的安全分享网址打开。')
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风，请使用新版 Chrome、Edge 或 Safari。')
    this.context = new AudioContext()
    try {
      await this.context.resume()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (this.canceled) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', this.trackEnded)
      this.encoder = new Pcm16Encoder(this.context.sampleRate)
      this.source = this.context.createMediaStreamSource(stream)
      this.sink = this.context.createGain(); this.sink.gain.value = 0
      const accept = (frame: Float32Array) => {
        if (this.canceled || !this.encoder) return
        const rms = this.encoder.append(frame)
        if (performance.now() - this.lastMeterTime >= 80 || this.encoder.full) { this.lastMeterTime = performance.now(); this.onMeter(this.encoder.seconds, rms) }
        if (this.encoder.full) this.onLimit()
      }
      if (this.context.audioWorklet) {
        const url = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }))
        try { await this.context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
        if (this.canceled) return
        const node = new AudioWorkletNode(this.context, 'flowboard-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
        node.port.onmessage = event => accept(event.data as Float32Array); this.node = node
      } else {
        const node = this.context.createScriptProcessor(2048, 1, 1)
        node.onaudioprocess = event => accept(event.inputBuffer.getChannelData(0)); this.node = node
      }
      this.source.connect(this.node); this.node.connect(this.sink); this.sink.connect(this.context.destination)
      this.timer = setTimeout(() => this.onLimit(), VOICE_MAX_SECONDS * 1000)
      this.ended = () => { if (document.visibilityState === 'hidden') this.onError(new Error('录音已因页面进入后台而取消。')) }
      document.addEventListener('visibilitychange', this.ended)
      if (document.visibilityState === 'hidden') this.trackEnded()
    } catch (error) {
      this.cancel()
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw new Error('未获得麦克风权限，请在地址栏允许麦克风后重试。')
      if (error instanceof DOMException && error.name === 'NotFoundError') throw new Error('未找到麦克风，请连接麦克风后重试。')
      throw error
    }
  }
  stop(): ArrayBuffer {
    const bytes = this.encoder?.finish() ?? new ArrayBuffer(0)
    this.cleanup()
    return bytes
  }
  cancel(): void { this.encoder?.clear(); this.cleanup() }
  private cleanup(): void {
    this.canceled = true
    clearTimeout(this.timer)
    if (this.ended) document.removeEventListener('visibilitychange', this.ended)
    this.ended = null
    if (typeof AudioWorkletNode !== 'undefined' && this.node instanceof AudioWorkletNode) { this.node.port.onmessage = null; this.node.port.close() }
    else if (this.node && 'onaudioprocess' in this.node) this.node.onaudioprocess = null
    this.source?.disconnect(); this.node?.disconnect(); this.sink?.disconnect()
    for (const track of this.stream?.getTracks() ?? []) { track.removeEventListener('ended', this.trackEnded); track.stop() }
    this.stream = null; this.node = null; this.source = null; this.sink = null
    const context = this.context; this.context = null
    if (context && context.state !== 'closed') void context.close().catch(() => {})
    this.encoder = null
  }
}

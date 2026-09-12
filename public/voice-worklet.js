/**
 * 语音采集 AudioWorklet：把麦克风输入降采样为 16kHz/16bit/mono PCM。
 *
 * 每凑满 100ms（1600 样本）postMessage 一个 Int16Array（transfer 所有权），
 * 主线程再攒 2 包 = 200ms 发给 Rust（豆包双向流式 200ms/包最优，见协议文档核对结论）。
 * 降采样用相位累积 + 线性插值，兼容任意输入采样率（44.1k/48k）。
 */
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.phase = 0 // 距下次输出的输入样本进度（0..ratio）
    this.last = 0
    this.buf = new Int16Array(1600) // 100ms @16k
    this.filled = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const t = ch[i]
        let frac = this.phase
        while (frac < 1) {
          const v = this.last + (t - this.last) * frac
          const s = Math.max(-1, Math.min(1, v))
          this.buf[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff
          if (this.filled >= this.buf.length) {
            const out = this.buf.slice(0)
            this.port.postMessage(out, [out.buffer])
            this.filled = 0
          }
          frac += this.ratio
        }
        this.phase = frac - 1
        this.last = t
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PCMCapture)

/**
 * 相位结束提示音 · Web Audio 合成（无音频资源、无权限）。
 *
 * 为什么出声：系统通知是「人不在电脑前」的送达通道，而声音补上「人在电脑前、但没看窗口」
 * 这一档——两个通道互补。刻意做得短促、克制（约 0.35 秒、正弦 + 轻微包络），
 * 提示但不吓人；也会兜住「系统通知发不出去」的情形。
 *
 * 幂等安全：`AudioContext` 惰性创建、只在首次播放时建（不在模块顶层，避免导入即占资源）；
 * 任何失败（浏览器策略、WebView2 限制）都静默——声音只是送达的补充，不能反过来拖垮计时。
 */

/** 惰性缓存的音频上下文；null 表示当前环境拿不到（此时播放静默失败）。 */
let ctx: AudioContext | null = null

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!ctx) {
      // 兼容旧 WebView 的前缀构造器；用 unknown 收窄而不是 any。
      const ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!ctor) return null
      ctx = new ctor()
    }
    // 浏览器自动播放策略可能把上下文挂在 suspended 上，恢复后才响。
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/**
 * 播一声相位结束提示音。
 * @param kind 刚结束的相位：focus = 专注结束（上行两音），break = 休息结束（下行两音）。
 */
export function playPhaseChime(kind: 'focus' | 'break'): void {
  const ac = ensureCtx()
  if (!ac) return
  try {
    const base = ac.currentTime
    const freqs = kind === 'focus' ? [740, 988] : [988, 740]
    freqs.forEach((freq, i) => {
      const t0 = base + i * 0.16
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t0)
      // 轻微包络：起音不爆、尾音不截断（总长约 0.32 秒）
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14)
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.start(t0)
      osc.stop(t0 + 0.15)
    })
  } catch {
    /* 播放失败静默：提示音只是送达的补充通道 */
  }
}
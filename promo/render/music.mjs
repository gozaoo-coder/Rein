/**
 * 卡点配乐 + 音效渲染器（纯 Node、零依赖、**确定性**）。
 *
 * 为什么是 120 BPM / 4/4：片子是**每 2.0s 一个爆点**。120 BPM 下一小节正好 2.0s，
 * 于是「第 k 拍（t = 2k）永远落在第 k 小节的强拍上」—— 每个场景切点天然被一个
 * 低音/和弦/镶边音砸中，不需要逐拍对表。这就是这条片子「卡点」的全部秘密。
 *
 * 产出两样（同一份音符事件）：
 *   out/rein-promo.wav  内置合成器渲染（加法/FM + 包络 + 反馈混响 + 软限幅），44.1k 16bit 立体声
 *   out/rein-promo.mid  标准 MIDI 文件（Tempo 120、4/4、30 小节）—— 拿去 DAW 换音色
 *
 * 确定性：所有噪声纹理走带种子的 PRNG，同一份代码每次渲染出**逐位相同**的 wav。
 * 用法：node render/music.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'out')

const SR = 44100
const BPM = 120
const BEAT = 60 / BPM // 0.5s
const BAR = BEAT * 4 // 2.0s —— 一个爆点
const BARS = 30
const DUR = BARS * BAR // 60.0s
const N = Math.round(DUR * SR)

const midiFreq = (m) => 440 * 2 ** ((m - 69) / 12)

/* ---------------- 带种子的 PRNG（噪声纹理用，保证可复现） ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------------- 乐曲结构 ---------------- */

// Am – F – C – G，每 4 小节一个和弦（8s），共 30 小节
const CHORDS = [
  [57, 60, 64, 69], // Am
  [53, 57, 60, 65], // F
  [60, 64, 67, 72], // C
  [55, 59, 62, 67], // G
]
const ROOTS = [45, 41, 48, 43] // 低音根音（A2 / F2 / C3 / G2）

/** 分层：跟随画面的叙事弧（弱起 → 渐强 → 峰值 → 收束） */
function section(bar) {
  if (bar < 5) return { pad: 0.5, bass: 0, perc: 0, pluck: 0, bright: 0 }
  if (bar < 10) return { pad: 0.62, bass: 0.5, perc: 0, pluck: 0.35, bright: 0 }
  if (bar < 19) return { pad: 0.72, bass: 0.7, perc: 0.5, pluck: 0.6, bright: 0.25 }
  if (bar < 26) return { pad: 0.85, bass: 0.85, perc: 0.62, pluck: 0.7, bright: 0.6 }
  return { pad: 0.6, bass: 0.35, perc: 0.25, pluck: 0.3, bright: 0.2 }
}

/** 计数读数滚动时的 tick（只在真的有数字滚动的爆点上叠） */
const TICK_BARS = [4, 7, 9, 10, 11, 13, 14, 15, 16, 19, 21, 22, 23, 26, 27]
/** 语义提示：落定/完成/锁上（一小枚短促上扬） */
const CHIME_BARS = [8, 12, 17, 18, 19, 22, 23, 27]

const events = { pad: [], stab: [], bass: [], bell: [], pluck: [], kick: [], sfx: [] }

for (let bar = 0; bar < BARS; bar += 1) {
  const t0 = bar * BAR
  const sec = section(bar)

  // ---- Pad：每 4 小节换一次和弦，长音铺底 ----
  if (bar % 4 === 0) {
    const chord = CHORDS[(bar / 4) % CHORDS.length]
    const dur = BAR * 4 + 1.6
    chord.forEach((m, i) => {
      events.pad.push({ start: t0, dur, midi: m, gain: 0.16 * sec.pad, pan: 0.32 + i * 0.12 })
      if (sec.bright > 0) {
        events.pad.push({ start: t0 + 0.3, dur: dur - 0.6, midi: m + 12, gain: 0.05 * sec.bright, pan: 0.5 })
      }
    })
  }

  // ---- Bass：每小节强拍一下 ----
  if (sec.bass > 0) {
    const root = ROOTS[(Math.floor(bar / 4)) % ROOTS.length]
    events.bass.push({ start: t0, dur: BAR * 0.85, midi: root, gain: 0.3 * sec.bass })
    if (sec.perc > 0.5) events.bass.push({ start: t0 + BEAT * 2, dur: BAR * 0.4, midi: root + 12, gain: 0.12 * sec.bass })
  }

  // ---- 卡点：每小节第一拍一记软重音 + 一记短和弦落点 ----
  // 这是「卡点」真正被听见的地方：每个场景切点都落在小节的强拍上。
  events.kick.push({ start: t0, gain: 0.3 + 0.34 * sec.perc })
  if (sec.perc > 0.5) events.kick.push({ start: t0 + BEAT * 2, gain: 0.12 * sec.perc })
  {
    const chord = CHORDS[Math.floor(bar / 4) % CHORDS.length]
    chord.forEach((m, i) => {
      events.stab.push({ start: t0, midi: m, gain: 0.05 + 0.07 * sec.perc + 0.03 * sec.bright, pan: 0.34 + i * 0.1 })
    })
  }

  // ---- Pluck 动机：每一小节的第 3 拍挂一枚，音高取自当前和弦 ----
  if (sec.pluck > 0) {
    const chord = CHORDS[(Math.floor(bar / 4)) % CHORDS.length]
    const m = chord[bar % chord.length] + 12
    events.pluck.push({ start: t0 + BEAT * 2.5, midi: m, gain: 0.1 * sec.pluck, pan: 0.6 })
  }

  // ---- 音效 ----
  // 转场 whoosh：每个爆点边界（与画面头带的进出同拍）
  events.sfx.push({ kind: 'whoosh', start: t0 - 0.12, gain: bar === 0 ? 0.05 : 0.1 })
  if (TICK_BARS.includes(bar)) events.sfx.push({ kind: 'tick', start: t0 + 0.12, count: 7, gain: 0.05 })
  if (CHIME_BARS.includes(bar)) events.sfx.push({ kind: 'chime', start: t0 + 0.34, gap: 0.11, gain: 0.1 })
}

// 书立：品牌（第 0 拍）与收尾（第 29 拍）各一枚钟声
events.bell.push({ start: 0.06, midi: 69, gain: 0.5, dur: 3.2 })
events.bell.push({ start: 29 * BAR + 0.04, midi: 76, gain: 0.42, dur: 3.6 })
events.bell.push({ start: 29 * BAR + 0.3, midi: 72, gain: 0.22, dur: 2.4 })

/* ---------------- 合成 ---------------- */

const L = new Float32Array(N)
const R = new Float32Array(N)
const at = (t) => Math.round(t * SR)

function put(i, v, pan = 0.5) {
  if (i < 0 || i >= N) return
  L[i] += v * (1 - pan)
  R[i] += v * pan
}

/** 垫音：3 个失谐振荡叠加，慢起慢落 + 一阶低通（暗而厚） */
function padNote({ start, dur, midi, gain, pan }) {
  const f = midiFreq(midi)
  const i0 = at(start)
  const i1 = Math.min(N, at(start + dur))
  const atk = 1.5 * SR
  const rel = 2.2 * SR
  const relFrom = i1 - rel
  let lp = 0
  for (let i = i0; i < i1; i += 1) {
    const n = i - i0
    let env = Math.min(1, n / atk)
    if (i > relFrom) env *= Math.max(0, 1 - (i - relFrom) / rel)
    const t = i / SR
    let s =
      Math.sin(2 * Math.PI * f * t) +
      0.42 * Math.sin(2 * Math.PI * f * 2.002 * t + 0.7) +
      0.2 * Math.sin(2 * Math.PI * f * 3.001 * t + 1.9) +
      0.45 * Math.sin(2 * Math.PI * f * 1.004 * t + 2.3) +
      0.3 * Math.sin(2 * Math.PI * f * 0.996 * t + 4.1)
    s *= 0.9 + 0.1 * Math.sin(2 * Math.PI * 0.11 * t + midi * 0.3)
    lp += (s - lp) * 0.1
    put(i, lp * env * gain, pan)
  }
}

/** 小节和弦落点：快起音、0.7s 衰减，给每个爆点一个明确的「落点」 */
function stabNote({ start, midi, gain, pan = 0.5 }) {
  const f = midiFreq(midi)
  const i0 = at(start)
  const i1 = Math.min(N, at(start + 0.8))
  const atk = 0.014 * SR
  for (let i = i0; i < i1; i += 1) {
    const n = i - i0
    const env = Math.min(1, n / atk) * Math.exp(-n / SR / 0.3)
    const t = i / SR
    const s =
      Math.sin(2 * Math.PI * f * t) * 0.6 +
      0.26 * Math.sin(2 * Math.PI * f * 2.004 * t + 0.4) +
      0.12 * Math.sin(2 * Math.PI * f * 3.01 * t + 1.2)
    put(i, s * env * gain, pan)
  }
}

/** 低音：正弦 + 一点点二次谐波，短促起音 */
function bassNote({ start, dur, midi, gain }) {
  const f = midiFreq(midi)
  const i0 = at(start)
  const i1 = Math.min(N, at(start + dur))
  const atk = 0.012 * SR
  const rel = 0.28 * SR
  const relFrom = i1 - rel
  for (let i = i0; i < i1; i += 1) {
    const n = i - i0
    let env = Math.min(1, n / atk)
    if (i > relFrom) env *= Math.max(0, 1 - (i - relFrom) / rel)
    const t = i / SR
    const s = Math.sin(2 * Math.PI * f * t) * 0.85 + Math.sin(2 * Math.PI * f * 2 * t) * 0.15
    put(i, s * env * gain, 0.5)
  }
}

/** 拨弦/颤音琴：几个泛音 + 指数衰减 */
function pluckNote({ start, midi, gain, pan = 0.5 }) {
  const f = midiFreq(midi)
  const i0 = at(start)
  const dur = 1.6
  const i1 = Math.min(N, at(start + dur))
  for (let i = i0; i < i1; i += 1) {
    const tt = (i - i0) / SR
    const env = Math.exp(-tt * 4.6)
    const s =
      Math.sin(2 * Math.PI * f * tt) * 0.7 +
      Math.sin(2 * Math.PI * f * 2.01 * tt) * 0.22 +
      Math.sin(2 * Math.PI * f * 3.02 * tt) * 0.09
    put(i, s * env * gain, pan)
  }
}

/** 钟声：FM（调制比 3.5），给品牌与收尾当书立 */
function bell({ start, midi, gain, dur = 3 }) {
  const fc = midiFreq(midi)
  const i0 = at(start)
  const i1 = Math.min(N, at(start + dur))
  for (let i = i0; i < i1; i += 1) {
    const tt = (i - i0) / SR
    const env = Math.exp(-tt * 1.9)
    const idx = 4.2 * Math.exp(-tt * 3.4)
    const s = Math.sin(2 * Math.PI * fc * tt + idx * Math.sin(2 * Math.PI * fc * 3.5 * tt))
    put(i, s * env * gain, 0.5)
  }
}

/** 软重音：45–90Hz 下滑脉冲（有分量但不刺耳） */
function kick({ start, gain }) {
  const i0 = at(start)
  const dur = 0.42
  const i1 = Math.min(N, at(start + dur))
  let ph = 0
  for (let i = i0; i < i1; i += 1) {
    const tt = (i - i0) / SR
    const f = 46 + 44 * Math.exp(-tt * 30)
    ph += (2 * Math.PI * f) / SR
    const env = Math.exp(-tt * 7.5)
    put(i, Math.sin(ph) * env * gain, 0.5)
  }
}

/** 转场 whoosh：带通噪声涌（左右去相关） */
function whoosh({ start, gain }, seed) {
  const rndL = mulberry32(seed)
  const rndR = mulberry32(seed + 977)
  const dur = 0.32
  const i0 = at(start)
  const i1 = Math.min(N, at(start + dur))
  let lpL = 0
  let lpR = 0
  for (let i = i0; i < i1; i += 1) {
    const u = (i - i0) / (dur * SR)
    const a = 0.05 + 0.4 * Math.sin(u * Math.PI)
    const nL = rndL() * 2 - 1
    const nR = rndR() * 2 - 1
    lpL += (nL - lpL) * a
    lpR += (nR - lpR) * a
    const env = Math.exp(-(((u - 0.5) * 3.1) ** 2))
    put(i, (nL - lpL) * env * gain, 0)
    put(i, (nR - lpR) * env * gain, 1)
  }
}

/** tick：极短的高频点，数字滚动用 */
function tick({ start, count, gain }) {
  for (let k = 0; k < count; k += 1) {
    const s0 = start + k * 0.055
    const i0 = at(s0)
    const dur = 0.03
    const i1 = Math.min(N, at(s0 + dur))
    for (let i = i0; i < i1; i += 1) {
      const tt = (i - i0) / SR
      const env = Math.exp(-tt * 140)
      put(i, Math.sin(2 * Math.PI * 2600 * tt) * env * gain, 0.58)
    }
  }
}

/** chime：两枚上行短音（落定/完成） */
function chime({ start, gap, gain }) {
  ;[0, 4].forEach((semi, k) => {
    const f = midiFreq(81 + semi)
    const s0 = start + k * gap
    const i0 = at(s0)
    const i1 = Math.min(N, at(s0 + 0.9))
    for (let i = i0; i < i1; i += 1) {
      const tt = (i - i0) / SR
      const env = Math.exp(-tt * 6)
      const idx = 3 * Math.exp(-tt * 6)
      put(i, Math.sin(2 * Math.PI * f * tt + idx * Math.sin(2 * Math.PI * f * 2.7 * tt)) * env * gain, 0.62)
    }
  })
}

/* ---------------- 调度 ---------------- */

for (const e of events.pad) padNote(e)
for (const e of events.stab) stabNote(e)
for (const e of events.bass) bassNote(e)
for (const e of events.pluck) pluckNote(e)
for (const e of events.bell) bell(e)
for (const e of events.kick) kick(e)
let sfxSeed = 20261018
for (const e of events.sfx) {
  if (e.kind === 'whoosh') whoosh(e, (sfxSeed += 131))
  else if (e.kind === 'tick') tick(e)
  else if (e.kind === 'chime') chime(e)
}

/* ---------------- 反馈混响（左右不同延迟 → 自然去相关） ---------------- */

function reverb(buf, delaySec, fb, wet) {
  const d = Math.max(1, Math.round(delaySec * SR))
  const line = new Float32Array(d)
  const out = new Float32Array(buf.length)
  let p = 0
  let lp = 0
  for (let i = 0; i < buf.length; i += 1) {
    const y = line[p]
    out[i] = y
    lp += (buf[i] + y * fb - lp) * 0.55
    line[p] = lp
    p = (p + 1) % d
  }
  for (let i = 0; i < buf.length; i += 1) buf[i] += out[i] * wet
}

reverb(L, 0.031, 0.72, 0.3)
reverb(R, 0.037, 0.72, 0.3)

/* ---------------- 归一化 + 软限幅（真峰 ≤ −1 dBTP） ---------------- */

let peak = 0
for (let i = 0; i < N; i += 1) {
  const a = Math.abs(L[i])
  const b = Math.abs(R[i])
  if (a > peak) peak = a
  if (b > peak) peak = b
}
const target = 1.0 // 送入 tanh 的峰值：tanh(1.0)≈0.762 → 约 −2.4 dBFS，限幅只轻触、不糊
const g = peak > 1e-6 ? target / peak : 1
let outPeak = 0
const pcm = Buffer.alloc(N * 4)
for (let i = 0; i < N; i += 1) {
  const ls = Math.tanh(L[i] * g)
  const rs = Math.tanh(R[i] * g)
  if (Math.abs(ls) > outPeak) outPeak = Math.abs(ls)
  if (Math.abs(rs) > outPeak) outPeak = Math.abs(rs)
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ls * 32767))), i * 4)
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(rs * 32767))), i * 4 + 2)
}

/* ---------------- WAV ---------------- */

function wavBuffer(pcmData) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmData.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(2, 22) // stereo
  header.writeUInt32LE(SR, 24)
  header.writeUInt32LE(SR * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcmData.length, 40)
  return Buffer.concat([header, pcmData])
}

/* ---------------- MIDI（标准文件 Type 1，Tempo 120、4/4、30 小节） ---------------- */

const PPQ = 480
const secToTick = (s) => Math.round((s / BEAT) * PPQ)

function vlq(n) {
  const bytes = [n & 0x7f]
  let v = n >> 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return Buffer.from(bytes)
}

function trackChunk(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order)
  const parts = []
  let last = 0
  for (const e of sorted) {
    parts.push(vlq(e.tick - last))
    parts.push(Buffer.from(e.bytes))
    last = e.tick
  }
  parts.push(vlq(0), Buffer.from([0xff, 0x2f, 0x00])) // end of track
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('MTrk', 0)
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

function noteEvents(list, channel, program) {
  const out = [
    { tick: 0, order: 0, bytes: [0xc0 | channel, program] },
  ]
  for (const e of list) {
    const on = secToTick(e.start)
    const off = secToTick(e.start + (e.dur ?? 1.6))
    const vel = Math.max(1, Math.min(127, Math.round((e.gain ?? 0.4) * 260)))
    out.push({ tick: on, order: 1, bytes: [0x90 | channel, e.midi, vel] })
    out.push({ tick: off, order: 0, bytes: [0x80 | channel, e.midi, 0] })
  }
  return out
}

function midiBuffer() {
  const header = Buffer.alloc(14)
  header.write('MThd', 0)
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(1, 8) // format 1
  header.writeUInt16BE(5, 10) // 5 tracks
  header.writeUInt16BE(PPQ, 12)

  const tempo = trackChunk([{ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }]) // 500000µs = 120BPM
  const pads = trackChunk([...noteEvents(events.pad, 0, 89), ...noteEvents(events.stab, 4, 89)])
  const bass = trackChunk(noteEvents(events.bass, 1, 38))
  const lead = trackChunk([...noteEvents(events.bell, 2, 9), ...noteEvents(events.pluck, 3, 11)])
  const perc = trackChunk(
    events.kick.map((e) => ({ tick: secToTick(e.start), order: 1, bytes: [0x99, 36, Math.max(1, Math.round(e.gain * 260))] }))
      .concat(events.kick.map((e) => ({ tick: secToTick(e.start + 0.12), order: 0, bytes: [0x89, 36, 0] }))),
  )
  return Buffer.concat([header, tempo, pads, bass, lead, perc])
}

/* ---------------- 写盘 ---------------- */

mkdirSync(OUT, { recursive: true })
const wavPath = join(OUT, 'rein-promo.wav')
const midPath = join(OUT, 'rein-promo.mid')
writeFileSync(wavPath, wavBuffer(pcm))
writeFileSync(midPath, midiBuffer())

const db = (v) => (20 * Math.log10(Math.max(v, 1e-6))).toFixed(1)
console.log(`✓ 配乐：${wavPath}`)
console.log(`  ${DUR.toFixed(2)}s · ${SR}Hz · 16bit 立体声 · ${BPM}BPM 4/4 · ${BARS} 小节`)
console.log(`  归一化前峰值 ${db(peak)}dB → 限幅后 ${db(outPeak)}dB（目标 −1.0dB）`)
console.log(`✓ MIDI：${midPath}（5 轨 · Tempo 120 · 4/4 · ${BARS} 小节）`)

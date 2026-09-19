/**
 * minisign 签名校验（纯 Node，无依赖）。
 *
 * 为什么自己实现而不引 npm 包：签名校验是整条更新链路的信任根，第三方包一旦
 * 供应链被投毒，改的正好是这里。格式本身很小（ed25519 + 一段 base64），
 * 自己写反而更容易逐字节核对；也用不着为此在服务器上多装一堆依赖。
 *
 * 与客户端一致性：算法取值、`signature` 字段「base64(.sig 文件全文)」的约定
 * 都按 tauri-plugin-updater 的 minisign_verify 行为对齐 —— 官方客户端能装的包，
 * 这里的校验必须同样通过。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

/** ed25519 公钥的 DER/SPKI 固定前缀（OID 1.3.101.112 + 32 字节裸钥）。 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const ALG_LEGACY = 'Ed' // 对消息本体签名（minisign 默认，tauri signer 用这个）
const ALG_PREHASHED = 'ED' // 对 blake2b-512 摘要签名

function tryBase64(text) {
  const cleaned = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (const line of cleaned) {
    if (line.startsWith('untrusted comment:') || line.startsWith('trusted comment:')) continue
    try {
      const buf = Buffer.from(line, 'base64')
      if (buf.length > 0) return buf
    } catch {
      /* 继续试下一行 */
    }
  }
  return null
}

/**
 * keyId 的展示口径：minisign 把它当作小端 u64 打印，而文件里是大端存储，
 * 所以展示时要反过来 —— 否则运维在服务器上看到的 id 和 minisign 工具的输出对不上。
 */
export function keyIdDisplay(bytes) {
  return Buffer.from(bytes).reverse().toString('hex').toUpperCase()
}

function decodeBase64ish(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  // 约定：字段值 = base64(.sig 文件全文)；但也容忍直接把 .sig 全文贴进来
  if (text.includes('comment:') || text.includes('\n')) return Buffer.from(text, 'utf8')
  try {
    const decoded = Buffer.from(text, 'base64')
    // base64 解出来是 .sig 文本（可打印 ASCII）→ 当作文件全文继续解析
    if (decoded.length > 0 && !decoded.includes(0) && decoded.toString('utf8').includes('comment:')) {
      return decoded
    }
    return decoded
  } catch {
    return null
  }
}

/**
 * 解析公钥。入参可以是：
 *  - 配置里的 base64（= base64(minisign 公钥文件全文)）—— tauri.conf.json 的 pubkey 就是这个
 *  - minisign 公钥文件全文（两行：untrusted comment + base64 载荷）
 * 返回 { keyId: 'A1B2…', key: Buffer(32), alg }
 */
export function parsePublicKey(input) {
  const raw = decodeBase64ish(input)
  if (!raw) throw new Error('公钥为空或不是合法 base64')

  let payload = null
  if (raw.toString('utf8').includes('comment:')) {
    payload = tryBase64(raw.toString('utf8'))
  } else {
    payload = raw
  }
  if (!payload || payload.length < 42) throw new Error('公钥载荷长度非法')

  const alg = payload.subarray(0, 2).toString('ascii')
  if (alg !== ALG_LEGACY && alg !== ALG_PREHASHED) {
    throw new Error(`不支持的签名算法：${JSON.stringify(alg)}`)
  }
  return {
    alg,
    keyId: keyIdDisplay(payload.subarray(2, 10)),
    key: payload.subarray(10, 42),
  }
}

/**
 * 解析签名。入参可以是 .sig 文件全文，或 base64(.sig 文件全文)（清单里的约定）。
 * 返回 { alg, keyId, sig: Buffer(64), trustedComment, globalSig: Buffer(64)|null }
 */
export function parseSignature(input) {
  const raw = decodeBase64ish(input)
  if (!raw) throw new Error('签名为空或不是合法 base64')
  const text = raw.toString('utf8')

  const lines = text.split(/\r?\n/)
  let payload = null
  let trustedComment = null
  let trustedCommentLine = -1

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('trusted comment:')) {
      trustedComment = line.slice('trusted comment:'.length).trim()
      trustedCommentLine = i
      continue
    }
    if (line.startsWith('untrusted comment:')) continue
    if (payload === null) {
      const buf = Buffer.from(line, 'base64')
      if (buf.length >= 74) payload = buf
    }
  }

  if (!payload) throw new Error('签名载荷缺失')
  const alg = payload.subarray(0, 2).toString('ascii')
  const signature = {
    alg,
    keyId: keyIdDisplay(payload.subarray(2, 10)),
    sig: payload.subarray(10, 74),
    trustedComment,
    globalSig: null,
  }

  // 全局签名（minisign 的 trusted comment 保护）：紧跟在 trusted comment 之后的那行
  if (trustedCommentLine >= 0) {
    for (let i = trustedCommentLine + 1; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!line) continue
      const buf = Buffer.from(line, 'base64')
      if (buf.length === 64) signature.globalSig = buf
      break
    }
  }
  return signature
}

function publicKeyObject(parsed) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, parsed.key]),
    format: 'der',
    type: 'spki',
  })
}

function verifyEd25519(pub, data, sig) {
  try {
    // 算法名 null = ed25519 的固定用法（Node 要求对 Ed25519 传 null）
    return crypto.verify(null, data, pub, sig)
  } catch {
    return false
  }
}

/**
 * 校验「消息 + minisign 签名」。
 * @returns {{ok: boolean, reason?: string, keyId?: string, prehashed?: boolean, trustedCommentOk?: boolean}}
 */
export function verifyMinisign(message, signatureInput, publicKeyInput) {
  let pub
  let sig
  try {
    pub = parsePublicKey(publicKeyInput)
  } catch (e) {
    return { ok: false, reason: `公钥解析失败：${e.message}` }
  }
  try {
    sig = parseSignature(signatureInput)
  } catch (e) {
    return { ok: false, reason: `签名解析失败：${e.message}` }
  }

  if (sig.keyId !== pub.keyId) {
    return { ok: false, reason: `签名 keyId(${sig.keyId}) 与公钥(${pub.keyId}) 不匹配` }
  }
  if (sig.alg !== ALG_LEGACY && sig.alg !== ALG_PREHASHED) {
    return { ok: false, reason: `不支持的签名算法：${JSON.stringify(sig.alg)}` }
  }

  const prehashed = sig.alg === ALG_PREHASHED
  const data = prehashed ? crypto.createHash('blake2b512').update(message).digest() : message
  const keyObject = publicKeyObject(pub)

  if (!verifyEd25519(keyObject, data, sig.sig)) {
    return { ok: false, reason: '主签名校验失败', keyId: sig.keyId, prehashed }
  }

  // trusted comment 的全局签名：有就顺带核对（可作额外证据），不通过只标记不拒绝 ——
  // 官方客户端（minisign-verify）以主签名为准，这里苛刻一分反而会把合法包挡在门外。
  let trustedCommentOk
  if (sig.globalSig && sig.trustedComment !== null) {
    const payloadLine = Buffer.concat([Buffer.from(sig.alg, 'ascii'), Buffer.from(sig.keyId, 'hex'), sig.sig])
    const globalData = Buffer.concat([payloadLine, Buffer.from(sig.trustedComment, 'utf8')])
    trustedCommentOk = verifyEd25519(keyObject, globalData, sig.globalSig)
  }

  return { ok: true, keyId: sig.keyId, prehashed, trustedCommentOk }
}

/** 流式 sha256（大文件不占内存）。 */
export function sha256File(file, onBytes) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    let size = 0
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => {
      hash.update(chunk)
      size += chunk.length
      onBytes?.(chunk.length)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }))
  })
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** 校验一个已落盘的安装包：sha256 + minisign 签名（签的必须是文件原始字节）。 */
export async function verifyFile({ file, sha256, signature, publicKey }) {
  const actual = await sha256File(file)
  if (sha256 && actual.sha256.toLowerCase() !== String(sha256).toLowerCase()) {
    return { ok: false, reason: `sha256 不匹配：期望 ${sha256}，实际 ${actual.sha256}` }
  }
  if (!signature) return { ok: false, reason: '缺少签名' }
  const bytes = await fs.promises.readFile(file)
  const result = verifyMinisign(bytes, signature, publicKey)
  return { ...result, sha256: actual.sha256, size: actual.size }
}

/** 从 .sig 文本里取 trusted comment 的时间戳（仅用于展示）。 */
export function signatureTimestamp(signatureInput) {
  try {
    const sig = parseSignature(signatureInput)
    const m = /timestamp:(\d+)/.exec(sig.trustedComment ?? '')
    if (m) return new Date(Number(m[1]) * 1000).toISOString()
  } catch {
    /* 展示用，失败无所谓 */
  }
  return null
}

export { ALG_LEGACY, ALG_PREHASHED, SPKI_ED25519_PREFIX }

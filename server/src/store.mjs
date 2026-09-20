/**
 * 发布存储：磁盘布局 + 发布校验 + 清单生成。
 *
 * 布局（dataDir 下）：
 *   channels/<channel>/index.json            发布历史（服务端生成，展示用）
 *   channels/<channel>/latest.json           客户端拉的清单（可能带 .sig）
 *   channels/<channel>/<version>/release.json 发布记录（含每个平台的签名摘要）
 *   channels/<channel>/<version>/<安装包>      安装包本体（原样字节）
 *
 * 关键约定：**服务端不持有私钥**。安装包签名由发布方（本地/CI）产出，服务端只做
 * 「校验 + 存储 + 原样分发」。这样服务器被拿下也签不出一个能装上的包。
 */
import fs from 'node:fs'
import path from 'node:path'

import { nowIso, safeChannel, safeFileName, safeVersion, writeAtomic } from './util.mjs'
import { sha256File, signatureTimestamp, verifyFile, verifyMinisign } from './verify.mjs'

const INDEX_FILE = 'index.json'
const LATEST_FILE = 'latest.json'
const LATEST_SIG_FILE = 'latest.json.sig'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export class Store {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg
    this.log = log
    this.root = path.join(cfg.dataDir, 'channels')
    fs.mkdirSync(this.root, { recursive: true })
  }

  channelDir(channel) {
    return path.join(this.root, channel)
  }

  releaseDir(channel, version) {
    return path.join(this.channelDir(channel), version)
  }

  indexPath(channel) {
    return path.join(this.channelDir(channel), INDEX_FILE)
  }

  /** 发布历史，按版本号从新到旧。 */
  listReleases(channel) {
    const index = readJson(this.indexPath(channel))
    return Array.isArray(index?.releases) ? index.releases : []
  }

  readIndex(channel) {
    return readJson(this.indexPath(channel)) ?? { channel, releases: [] }
  }

  writeIndex(channel, index) {
    index.channel = channel
    index.updatedAt = nowIso()
    writeAtomic(this.indexPath(channel), `${JSON.stringify(index, null, 2)}\n`)
  }

  getRelease(channel, version) {
    const file = path.join(this.releaseDir(channel, version), 'release.json')
    return readJson(file)
  }

  manifestPath(channel) {
    return path.join(this.channelDir(channel), LATEST_FILE)
  }

  readManifest(channel) {
    return readJson(this.manifestPath(channel))
  }

  readManifestSignature(channel) {
    try {
      return fs.readFileSync(path.join(this.channelDir(channel), LATEST_SIG_FILE), 'utf8').trim()
    } catch {
      return null
    }
  }

  /** 当前通道指向的版本（最新清单里的 version）。 */
  currentVersion(channel) {
    return this.readManifest(channel)?.version ?? null
  }

  /**
   * 落一个安装包。以流写入，边写边算 sha256（几十上百 MB 的文件不能进内存）。
   * @returns {Promise<{file: string, sha256: string, size: number}>}
   */
  saveArtifact(channel, version, fileName, readable) {
    const clean = safeFileName(fileName)
    if (!clean) throw Object.assign(new Error(`非法文件名：${fileName}`), { status: 400 })
    const dir = this.releaseDir(channel, version)
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, clean)

    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target)
      let size = 0
      readable.on('data', (chunk) => {
        size += chunk.length
      })
      readable.on('error', reject)
      out.on('error', reject)
      out.on('close', async () => {
        try {
          const { sha256 } = await sha256File(target)
          resolve({ file: clean, sha256, size })
        } catch (e) {
          reject(e)
        }
      })
      readable.pipe(out)
    })
  }

  /**
   * 发布一个版本。
   * @param {object} record 见 README「发布记录」；platforms[target].file 必须已上传
   * @param {object} [opts]
   * @param {object} [opts.manifest] 客户端清单原文（发布方生成；给了就原样存）
   * @param {string} [opts.manifestSignature] base64(.sig 全文)
   */
  async publish(record, opts = {}) {
    const channel = safeChannel(record.channel, this.cfg.update.channels)
    if (!channel) throw Object.assign(new Error(`通道非法：${record.channel}`), { status: 400 })
    const version = safeVersion(record.version)
    if (!version) throw Object.assign(new Error(`版本号非法：${record.version}`), { status: 400 })

    const platforms = record.platforms && typeof record.platforms === 'object' ? record.platforms : {}
    const targets = Object.keys(platforms)
    if (targets.length === 0) throw Object.assign(new Error('platforms 不能为空'), { status: 400 })

    const dir = this.releaseDir(channel, version)
    if (!fs.existsSync(dir)) throw Object.assign(new Error(`版本目录不存在（请先上传安装包）：${version}`), { status: 400 })

    const verified = {}
    for (const target of targets) {
      const entry = platforms[target] ?? {}
      const file = safeFileName(entry.file ?? entry.fileName)
      if (!file) throw Object.assign(new Error(`[${target}] 缺少 file`), { status: 400 })
      const abs = path.join(dir, file)
      if (!fs.existsSync(abs)) throw Object.assign(new Error(`[${target}] 安装包不存在：${file}`), { status: 400 })

      const { sha256, size } = await sha256File(abs)
      if (entry.sha256 && String(entry.sha256).toLowerCase() !== sha256) {
        throw Object.assign(
          new Error(`[${target}] sha256 与文件不符：声明 ${entry.sha256}，实际 ${sha256}`),
          { status: 400 },
        )
      }
      if (entry.size && Number(entry.size) !== size) {
        throw Object.assign(new Error(`[${target}] size 与文件不符：声明 ${entry.size}，实际 ${size}`), {
          status: 400,
        })
      }

      // 有公钥就强校验签名：签不出合法签名的包绝不入库
      let signKeyId = null
      if (this.cfg.update.publicKey) {
        if (!entry.signature) {
          if (this.cfg.update.requireSignature) {
            throw Object.assign(new Error(`[${target}] 缺少 signature（本服务要求签名）`), { status: 400 })
          }
        } else {
          const result = await verifyFile({
            file: abs,
            sha256,
            signature: entry.signature,
            publicKey: this.cfg.update.publicKey,
          })
          if (!result.ok) throw Object.assign(new Error(`[${target}] 签名校验失败：${result.reason}`), { status: 400 })
          signKeyId = result.keyId
        }
      }

      verified[target] = {
        file,
        url: `${this.cfg.publicBaseUrl}/dl/${channel}/${version}/${encodeURIComponent(file)}`,
        signature: entry.signature ?? null,
        sha256,
        size,
        mirrors: Array.isArray(entry.mirrors) ? entry.mirrors.filter((m) => typeof m === 'string') : [],
        minVersion: entry.minVersion ?? null,
        signKeyId,
      }
    }

    const releaseRecord = {
      channel,
      version,
      notes: typeof record.notes === 'string' ? record.notes : '',
      publishedAt: record.publishedAt ?? nowIso(),
      mandatory: Boolean(record.mandatory),
      minVersion: record.minVersion ?? null,
      platforms: verified,
      mirroredFrom: record.mirroredFrom ?? null,
      signatureTimestamp: Object.values(verified)
        .map((p) => (p.signature ? signatureTimestamp(p.signature) : null))
        .find(Boolean) ?? null,
    }

    writeAtomic(path.join(dir, 'release.json'), `${JSON.stringify(releaseRecord, null, 2)}\n`)

    const index = this.readIndex(channel)
    const rest = index.releases.filter((r) => r.version !== version)
    index.releases = [
      {
        version,
        publishedAt: releaseRecord.publishedAt,
        mandatory: releaseRecord.mandatory,
        notes: releaseRecord.notes,
        targets: Object.keys(verified),
        mirroredFrom: releaseRecord.mirroredFrom,
      },
      ...rest,
    ].sort((a, b) => compareVersions(b.version, a.version))
    this.writeIndex(channel, index)

    const shouldPublish = record.publish !== false
    if (shouldPublish) {
      // 清单是「签名对象」，必须原样字节落盘：发布方签的是它自己序列化出来的那份文本，
      // 服务端重新 stringify 一次就可能（键序/数字格式）与原字节不一致而验签失败。
      const manifestText =
        typeof opts.manifestText === 'string'
          ? ensureTrailingNewline(opts.manifestText)
          : `${JSON.stringify(opts.manifest ?? this.buildManifest(channel, releaseRecord), null, 2)}\n`
      if (opts.manifestSignature) {
        const check = this.verifyManifestText(manifestText, opts.manifestSignature)
        if (!check.ok && this.cfg.update.requireSignature && !record.mirroredFrom) {
          throw Object.assign(new Error(`清单签名校验失败：${check.reason}`), { status: 400 })
        }
      }
      writeAtomic(this.manifestPath(channel), manifestText)
      const sigPath = path.join(this.channelDir(channel), LATEST_SIG_FILE)
      if (opts.manifestSignature) {
        writeAtomic(sigPath, String(opts.manifestSignature).trim())
      } else {
        // 镜像来的版本 URL 被改写过，签名不再对得上 —— 宁可不带，也不带一个假的
        try {
          fs.rmSync(sigPath)
        } catch {
          /* 本来就没有 */
        }
      }
    }

    this.prune(channel)
    this.log('publish', { channel, version, targets, published: shouldPublish })
    return releaseRecord
  }

  /** 按平台记录拼一份客户端清单（Tauri static JSON 形态 + Rein 扩展字段）。 */
  buildManifest(channel, release) {
    const platforms = {}
    for (const [target, p] of Object.entries(release.platforms)) {
      platforms[target] = {
        url: p.url,
        signature: p.signature ?? '',
        ...(p.sha256 ? { sha256: p.sha256 } : {}),
        ...(p.size ? { size: p.size } : {}),
        ...(p.mirrors?.length ? { mirrors: p.mirrors } : {}),
        ...(p.file ? { name: p.file } : {}),
      }
    }
    return {
      version: release.version,
      notes: release.notes,
      pub_date: release.publishedAt,
      channel: release.channel,
      mandatory: release.mandatory,
      platforms,
      'x-rein': {
        generator: 'rein-update-server',
        generatedAt: nowIso(),
        minVersion: release.minVersion ?? null,
        baseUrl: this.cfg.publicBaseUrl,
        mirroredFrom: release.mirroredFrom ?? null,
      },
    }
  }

  verifyManifestText(manifestText, signature) {
    if (!this.cfg.update.publicKey) return { ok: false, reason: '服务端未配置公钥，无法校验清单签名' }
    return verifyMinisign(Buffer.from(manifestText, 'utf8'), signature, this.cfg.update.publicKey)
  }

  /** 校验已落盘的安装包（镜像流程与自检脚本共用）。 */
  async verifyArtifactFile({ channel, version, file, sha256, signature }) {
    const abs = path.join(this.releaseDir(channel, version), file)
    if (!fs.existsSync(abs)) return { ok: false, reason: `文件不存在：${file}` }
    if (!this.cfg.update.publicKey) return { ok: false, reason: '服务端未配置更新公钥' }
    return verifyFile({ file: abs, sha256, signature, publicKey: this.cfg.update.publicKey })
  }

  /** 把某版本设为通道当前版本（回滚 = 把 latest 指回旧版本，安装包不必重新上传）。 */
  setLatest(channel, version) {
    const release = this.getRelease(channel, version)
    if (!release) throw Object.assign(new Error(`版本不存在：${version}`), { status: 404 })
    const manifest = this.buildManifest(channel, release)
    writeAtomic(this.manifestPath(channel), `${JSON.stringify(manifest, null, 2)}\n`)
    try {
      fs.rmSync(path.join(this.channelDir(channel), LATEST_SIG_FILE))
    } catch {
      /* 重新生成的清单没有发布方签名，客户端按「无清单签名但安装包已验签」处理 */
    }
    this.log('promote', { channel, version })
    return manifest
  }

  deleteRelease(channel, version) {
    const dir = this.releaseDir(channel, version)
    if (!fs.existsSync(dir)) throw Object.assign(new Error(`版本不存在：${version}`), { status: 404 })
    fs.rmSync(dir, { recursive: true, force: true })
    const index = this.readIndex(channel)
    index.releases = index.releases.filter((r) => r.version !== version)
    this.writeIndex(channel, index)
    this.log('delete', { channel, version })
  }

  /** 只保留最近 keepVersions 个版本，避免 40G 盘被安装包堆满。 */
  prune(channel) {
    const keep = Number(this.cfg.update.keepVersions ?? 8)
    const index = this.readIndex(channel)
    const sorted = [...index.releases].sort((a, b) => compareVersions(b.version, a.version))
    const current = this.currentVersion(channel)
    const doomed = sorted.filter((r, i) => i >= keep && r.version !== current)
    for (const r of doomed) {
      fs.rmSync(this.releaseDir(channel, r.version), { recursive: true, force: true })
      this.log('prune', { channel, version: r.version })
    }
    if (doomed.length > 0) {
      const gone = new Set(doomed.map((r) => r.version))
      index.releases = index.releases.filter((r) => !gone.has(r.version))
      this.writeIndex(channel, index)
    }
  }

  /** 通道概况（管理接口用）。 */
  stats(channel) {
    const index = this.readIndex(channel)
    const latest = this.readManifest(channel)
    const releases = index.releases.map((r) => {
      const dir = this.releaseDir(channel, r.version)
      let bytes = 0
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          try {
            bytes += fs.statSync(path.join(dir, f)).size
          } catch {
            /* 目录在扫描时被删，忽略 */
          }
        }
      }
      return { ...r, bytes, current: r.version === latest?.version }
    })
    return {
      channel,
      current: latest?.version ?? null,
      manifestSigned: Boolean(this.readManifestSignature(channel)),
      releases,
      totalBytes: releases.reduce((n, r) => n + r.bytes, 0),
    }
  }
}

/** 语义化版本比较（只比较数字段；预发布标记按字符串兜底）。 */
export function compareVersions(a, b) {
  const pa = String(a).split('-')
  const pb = String(b).split('-')
  const na = pa[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const nb = pb[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0)
    if (d !== 0) return d
  }
  if (pa[1] && pb[1]) return pa[1].localeCompare(pb[1])
  if (pa[1]) return -1
  if (pb[1]) return 1
  return 0
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

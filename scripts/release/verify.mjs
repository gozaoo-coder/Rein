#!/usr/bin/env node
/**
 * 更新链路端到端校验：把「客户端会做的事」在命令行里重做一遍。
 *
 * 它回答的问题不是「服务器通不通」，而是这三件事：
 *   1. 清单能不能拉到、清单签名（如果有）对不对；
 *   2. 安装包下载下来的字节，sha256 与清单一致吗；
 *   3. 这些字节的 Ed25519 签名，用内置公钥验得过吗 —— 只有这一条过了，
 *      客户端才会真的去安装。
 *
 * 用法：
 *   node scripts/release/verify.mjs --manifest http://47.100.36.179:8787/updates/latest.json
 *   node scripts/release/verify.mjs --manifest ... --target android-aarch64
 *   node scripts/release/verify.mjs --manifest http://127.0.0.1:8787/updates/latest.json \
 *     --via http://127.0.0.1:8787          # 安全组没放行时，走 SSH 隧道把安装包也验完
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { REPO_ROOT, fail, formatSize, log } from './lib.mjs'
import { parsePublicKey, verifyMinisign } from '../../server/src/verify.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) fail(`参数 ${a} 缺少取值`)
      i += 1
      return v
    }
    if (a === '--manifest') out.manifest = next()
    else if (a === '--target') out.target = next()
    else if (a === '--key') out.key = next()
    else if (a === '--via') out.via = next()
    else if (a === '--download') out.download = true
    else if (a === '--out') out.out = next()
    else fail(`未知参数：${a}`)
  }
  return out
}

/**
 * 把远端地址换成隧道地址：路径与查询保留，只换 origin。
 * 用途是「公网端口还没放行时，用 SSH 隧道把整条链路先验一遍」——
 * 验的是同一份字节、同一份签名，只是走的入口不同。
 */
function rewriteVia(url, via) {
  if (!via) return url
  const base = new URL(via)
  const target = new URL(url)
  target.protocol = base.protocol
  target.host = base.host
  return target.toString()
}

/** 内置公钥：直接从 keys.rs 里读，保证「命令行校验」与「App 校验」用的是同一把钥匙。 */
function embeddedPublicKey() {
  const file = path.join(REPO_ROOT, 'src-tauri', 'src', 'modules', 'update', 'keys.rs')
  if (!fs.existsSync(file)) return null
  const m = /UPDATE_PUBKEY:\s*&str\s*=\s*"([^"]+)"/.exec(fs.readFileSync(file, 'utf8'))
  return m ? m[1] : null
}

function hostTarget() {
  const osName = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'darwin' : 'linux'
  const arch = os.arch() === 'arm64' ? 'aarch64' : os.arch() === 'ia32' ? 'i686' : os.arch()
  return `${osName}-${arch}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.manifest) fail('缺少 --manifest <清单地址或本地路径>')

  const pubkey = args.key ?? embeddedPublicKey()
  if (!pubkey) fail('找不到公钥：先跑 node scripts/release/keygen.mjs，或用 --key 指定')

  let parsed
  try {
    parsed = parsePublicKey(pubkey)
  } catch (e) {
    fail(`公钥无法解析：${e.message}`)
  }
  log(`\n▶ 校验清单 ${args.manifest}`)
  log(`   签名公钥 keyId=${parsed.keyId}`)
  // 1) 清单
  let manifestText
  if (/^https?:\/\//.test(args.manifest)) {
    const res = await fetch(args.manifest, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) fail(`拉取清单失败：HTTP ${res.status}`)
    manifestText = await res.text()
  } else {
    manifestText = fs.readFileSync(path.resolve(REPO_ROOT, args.manifest), 'utf8')
  }

  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (e) {
    fail(`清单不是合法 JSON：${e.message}`)
  }
  log(`   版本 ${manifest.version} · 通道 ${manifest.channel ?? '(未标注)'} · 发布于 ${manifest.pub_date ?? '?'}`)

  // 2) 清单签名（有就验，验不过直接判死 —— 服务端是可被改动的中间层）
  if (/^https?:\/\//.test(args.manifest)) {
    const sigRes = await fetch(`${args.manifest}.sig`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (sigRes?.ok) {
      const sigText = (await sigRes.text()).trim()
      const check = verifyMinisign(Buffer.from(manifestText, 'utf8'), sigText, pubkey)
      if (!check.ok) fail(`清单签名校验失败：${check.reason}`)
      log(`   ✓ 清单签名有效（${check.prehashed ? 'ED/预哈希' : 'Ed/直签'}）`)
    } else {
      log('   · 清单无伴随签名（客户端此时只依赖安装包签名）')
    }
  }

  // 3) 平台条目
  const target = args.target ?? hostTarget()
  const entry = manifest.platforms?.[target]
  if (!entry) {
    fail(`清单里没有 ${target} 的条目（可用：${Object.keys(manifest.platforms ?? {}).join(', ') || '无'}）`)
  }
  log(`\n   目标 ${target}`)
  log(`   URL   ${entry.url}`)
  log(`   大小  ${entry.size ? formatSize(entry.size) : '(清单未声明)'}`)
  log(`   摘要  ${entry.sha256 ?? '(清单未声明)'}`)
  if (args.via) log(`   隧道  ${args.via}（仅本次校验的下载路径，清单里的地址不变）`)

  if (!entry.signature) fail('该平台条目没有签名，客户端会拒绝安装')

  // 4) 下载到临时文件（流式，边下边算 sha256 —— 与客户端同一套判断顺序）
  const tmp = path.join(
    args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rein-verify-')),
    entry.name ?? path.basename(new URL(entry.url).pathname),
  )
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  log(`\n   下载到 ${tmp}`)

  const crypto = await import('node:crypto')
  const hash = crypto.createHash('sha256')
  const res = await fetch(rewriteVia(entry.url, args.via), { signal: AbortSignal.timeout(20 * 60_000) })
  if (!res.ok || !res.body) fail(`下载失败：HTTP ${res.status}`)
  const out = fs.createWriteStream(tmp)
  let written = 0
  for await (const chunk of res.body) {
    hash.update(chunk)
    written += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  const sha256 = hash.digest('hex')

  log(`   ✓ 已下载 ${formatSize(written)}`)

  // 5) 摘要 + 签名
  if (entry.sha256 && entry.sha256.toLowerCase() !== sha256) {
    fail(`sha256 不匹配：清单 ${entry.sha256}，实际 ${sha256}`)
  }
  if (entry.size && Number(entry.size) !== written) {
    fail(`size 不匹配：清单 ${entry.size}，实际 ${written}`)
  }
  log('   ✓ 摘要一致')

  const bytes = fs.readFileSync(tmp)
  const check = verifyMinisign(bytes, entry.signature, pubkey)
  if (!check.ok) fail(`安装包签名校验失败：${check.reason}`)
  log(`   ✓ 安装包签名有效（keyId=${check.keyId}）`)

  // 6) 镜像可达性（客户端在首选源失败时会回落）
  for (const mirror of entry.mirrors ?? []) {
    try {
      const head = await fetch(mirror, { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
      log(`   ${head.ok ? '✓' : '✖'} 镜像 ${mirror} → HTTP ${head.status}`)
    } catch (e) {
      log(`   ✖ 镜像 ${mirror} → ${e.message}`)
    }
  }

  log(`\n✔ ${target} 的这一版可以被信任并安装\n`)
}

main().catch((e) => fail(e.stack ?? String(e)))

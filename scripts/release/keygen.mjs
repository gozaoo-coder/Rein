#!/usr/bin/env node
/**
 * 生成 Rein 更新签名密钥对（Ed25519 / minisign），并把公钥同步进三处：
 *   1. src-tauri/src/modules/update/keys.rs  —— 客户端内置的信任根（编译进二进制）
 *   2. src-tauri/tauri.conf.json             —— plugins.updater.pubkey（留给官方插件用）
 *   3. server/config.json                    —— 服务端发布时的验签公钥
 *
 * 私钥只落本地（src-tauri/keys/，已 gitignore），绝不入库；
 * CI 里用 GitHub Secrets 的 TAURI_SIGNING_PRIVATE_KEY / _PASSWORD 注入。
 *
 *   node scripts/release/keygen.mjs                 # 交互确认后覆盖
 *   node scripts/release/keygen.mjs --force         # 直接覆盖（旧私钥作废，已发版本将无法再更新）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, fail, generateKeypair, log, readJson } from './lib.mjs'

const force = process.argv.includes('--force')
const keyDir = path.join(REPO_ROOT, 'src-tauri', 'keys')
const keyPath = path.join(keyDir, 'rein-update.key')
const passwordPath = path.join(keyDir, 'rein-update.key.password')

if (fs.existsSync(keyPath) && !force) {
  fail(
    [
      `私钥已存在：${keyPath}`,
      '重新生成会让已经发出去的版本全部无法再更新（客户端的信任根换了）。',
      '确实要换密钥，请加 --force，并记得同步更新 GitHub Secrets。',
    ].join('\n'),
  )
}

fs.mkdirSync(keyDir, { recursive: true })
// 私钥口令随机生成：它只防「私钥文件被翻到」，真正的保护是文件不进版本库
const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? crypto.randomBytes(24).toString('base64url')

log('→ 正在生成密钥对（tauri signer generate）…')
const { publicKey } = generateKeypair({ keyPath, password })
fs.writeFileSync(
  passwordPath,
  `# Rein 更新私钥口令（本文件与私钥同级，均已 gitignore）\n# CI 用 GitHub Secrets: TAURI_SIGNING_PRIVATE_KEY_PASSWORD\n${password}\n`,
  'utf8',
)

// 1) 客户端内置公钥
const keysRs = path.join(REPO_ROOT, 'src-tauri', 'src', 'modules', 'update', 'keys.rs')
fs.mkdirSync(path.dirname(keysRs), { recursive: true })
fs.writeFileSync(
  keysRs,
  `//! 更新签名公钥（由 \`node scripts/release/keygen.mjs\` 生成，改动此文件等于更换信任根）。\n\
//!\n\
//! 格式：base64(minisign 公钥文件全文)，与 tauri-plugin-updater 的 pubkey 配置一致。\n\
//! 客户端只认这把钥匙签出来的安装包 —— 服务器被拿下也推不出能装上的更新。\n\n\
pub const UPDATE_PUBKEY: &str = "${publicKey}";\n`,
  'utf8',
)

// 2) tauri.conf.json（官方 updater 插件将来若要启用，公钥已就位）
//    刻意不开 bundle.createUpdaterArtifacts：Rein 走自建更新链路（modules/update），
//    分发的是普通 NSIS 安装包；开了它，本地 `npm run app:build` 会因为缺少签名私钥直接报错。
const confPath = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json')
const conf = readJson(confPath)
conf.plugins = conf.plugins ?? {}
conf.plugins.updater = { ...(conf.plugins.updater ?? {}), pubkey: publicKey }
fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8')

// 3) 服务端配置（在场的就顺手写上，没部署也不影响）
const serverConfig = path.join(REPO_ROOT, 'server', 'config.json')
if (fs.existsSync(serverConfig)) {
  const cfg = readJson(serverConfig)
  cfg.update = { ...(cfg.update ?? {}), publicKey }
  fs.writeFileSync(serverConfig, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  log(`   ✓ 已写入 ${path.relative(REPO_ROOT, serverConfig)}`)
}

log(
  [
    '',
    '✔ 密钥对已生成',
    `   私钥：${path.relative(REPO_ROOT, keyPath)}`,
    `   口令：${path.relative(REPO_ROOT, passwordPath)}`,
    '',
    '   公钥（已写入 keys.rs / tauri.conf.json / server config）：',
    `   ${publicKey}`,
    '',
    '   下一步（GitHub Actions 要能签名，必须做这一步）：',
    '   1) 仓库 Settings → Secrets and variables → Actions → New repository secret',
    '      TAURI_SIGNING_PRIVATE_KEY          = 私钥文件全文（整份粘贴）',
    '      TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 上面口令文件里的那串',
    '      REIN_UPDATE_TOKEN                  = 服务端管理令牌（部署脚本会打印）',
    '   2) 把私钥与口令另存一份到密码管理器 —— 丢了就再也发不出可用的更新',
    '',
  ].join('\n'),
)

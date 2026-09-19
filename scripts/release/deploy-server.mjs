#!/usr/bin/env node
/**
 * 把 server/ 部署到阿里云 ECS（在 ECS 上以 root 安装为 systemd 服务）。
 *
 *   node scripts/release/deploy-server.mjs                 # 默认 root@47.100.36.179
 *   REIN_SSH_HOST=root@1.2.3.4 node scripts/release/deploy-server.mjs
 *
 * SSH 认证沿用你本机已有的方式（密钥或 askpass），脚本不接触任何口令。
 * 幂等：重复执行即升级；服务端的配置与已发布数据不会被覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { REPO_ROOT, fail, loadReleaseConfig, log } from './lib.mjs'

const HOST = process.env.REIN_SSH_HOST ?? 'root@47.100.36.179'
const REMOTE_STAGE = process.env.REIN_REMOTE_STAGE ?? '/tmp/rein-server-stage'
const dryRun = process.argv.includes('--dry-run')
const PORT = process.env.REIN_UPDATE_PORT ?? '8787'
// 认证方式随环境：装了密钥就直接用；只有密码时按 skill 里的 askpass 走 ——
// 那种情况下必须用 Git 自带的 ssh/scp（Windows 内置的不会执行 .sh 形式的 askpass）。
const SSH = process.env.REIN_SSH_BIN ?? 'ssh'
const SCP = process.env.REIN_SCP_BIN ?? 'scp'

/** 内置公钥：服务端要靠它校验发布方签名，部署时一并对齐。 */
function readPublicKey() {
  const file = path.join(REPO_ROOT, 'src-tauri', 'keys', 'rein-update.key.pub')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
}

/** 复制 server/ 到本地暂存目录（排除数据、配置与依赖）。 */
function buildStage() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rein-deploy-'))
  const src = path.join(REPO_ROOT, 'server')
  const dst = path.join(stage, 'server')
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p).replace(/\\/g, '/')
      return !rel.startsWith('data') && !rel.startsWith('node_modules') && rel !== 'config.json'
    },
  })
  return stage
}

function run(cmd, args, opts = {}) {
  log(`   $ ${cmd} ${args.map((a) => (a.length > 80 ? `${a.slice(0, 60)}…` : a)).join(' ')}`)
  if (dryRun) return
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.error) fail(`${cmd} 执行失败：${res.error.message}`)
  if (res.status !== 0) fail(`${cmd} 退出码 ${res.status}`)
}

function main() {
  const cfg = loadReleaseConfig()
  const baseUrl = process.env.REIN_PUBLIC_BASE_URL ?? cfg.serverBaseUrl
  const publicKey = readPublicKey()
  log(`\n▶ 部署在线服务到 ${HOST}`)
  log(`   对外地址 ${baseUrl}`)
  log(`   更新公钥 ${publicKey ? `${publicKey.slice(0, 24)}…（已随部署写入服务端）` : '未生成（先跑 keygen.mjs）'}`)

  const stage = buildStage()
  log(`   本地暂存 ${stage}`)
  const sshOpts = ['-o', 'StrictHostKeyChecking=accept-new']
  try {
    run(SSH, [...sshOpts, HOST, `rm -rf ${REMOTE_STAGE} && mkdir -p ${REMOTE_STAGE}`])
    run(SCP, [...sshOpts, '-r', path.join(stage, 'server'), `${HOST}:${REMOTE_STAGE}/`])
    const installArgs = [
      `bash ${REMOTE_STAGE}/server/deploy/install.sh`,
      `--stage=${REMOTE_STAGE}`,
      `--base-url=${baseUrl}`,
      `--port=${PORT}`,
    ]
    if (publicKey) installArgs.push(`--public-key=${publicKey}`)
    run(SSH, [...sshOpts, HOST, installArgs.join(' ')])
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }

  log(
    [
      '',
      '✔ 部署完成',
      '',
      '  接下来（各一次）：',
      `   1. 阿里云控制台放行安全组入方向 TCP ${PORT}（否则公网访问不到）`,
      `   2. 把上面打印的管理令牌写进 scripts/release/release.config.json 的 adminToken，`,
      '      或设环境变量 REIN_UPDATE_TOKEN=（CI 里是 GitHub Secret: REIN_UPDATE_TOKEN）',
      '   3. 发一版：node scripts/release/publish.mjs --version 0.2.1 --target <平台>=<文件>',
      '',
    ].join('\n'),
  )
}

try {
  main()
} catch (e) {
  fail(e.stack ?? String(e))
}

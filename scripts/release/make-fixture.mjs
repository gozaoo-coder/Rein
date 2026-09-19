#!/usr/bin/env node
/**
 * 重新生成 Rust 侧验签回归夹具（src-tauri/src/modules/update/fixtures/signature.txt）。
 *
 * 这是**跨实现互操作**的锚点：用官方 tauri CLI 签一段固定消息，把签名结果存成夹具，
 * Rust 单测（`update::verify::tests`）必须能验过它。换密钥或改验签实现后重跑本脚本。
 *
 *   node scripts/release/make-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, fail, loadReleaseConfig, log, signFile } from './lib.mjs'

/** 与 verify.rs 里的 FIXTURE_MESSAGE 必须逐字节一致 */
const MESSAGE = 'rein-update-verify-fixture-v1\n'

function main() {
  const cfg = loadReleaseConfig()
  const dir = path.join(REPO_ROOT, 'src-tauri', 'src', 'modules', 'update', 'fixtures')
  fs.mkdirSync(dir, { recursive: true })
  const msgFile = path.join(dir, 'message.bin')
  fs.writeFileSync(msgFile, MESSAGE, 'utf8')

  const { signature } = signFile(msgFile, { keyPath: cfg.keyPath, password: cfg.keyPassword })
  const sigFile = path.join(dir, 'signature.txt')
  fs.writeFileSync(sigFile, `${signature}\n`, 'utf8')
  fs.rmSync(msgFile, { force: true })

  log(`✔ 夹具已更新：${path.relative(REPO_ROOT, sigFile)}`)
  log('  别忘记同步更新 verify.rs 里的 FIXTURE_MESSAGE（若消息变了）')
}

try {
  main()
} catch (e) {
  fail(e.stack ?? String(e))
}

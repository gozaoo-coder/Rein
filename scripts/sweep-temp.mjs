#!/usr/bin/env node
/**
 * 清理 %TEMP% 下 rein- 前缀的陈旧测试临时数据。
 *
 * 谁在留这些目录：scripts 目录下 e2e 与审计脚本的无头 Edge profile（`${TEMP}/rein-e2e-*`）、
 * cargo test 的 scratch（`rein-kb-assets-*-<pid>`，每个测试进程一份）、
 * 发布流水线的 staging（`rein-sign-` / `rein-verify-` / `rein-deploy-`）。
 * 它们只增不减，实测一次开发周期能堆到 100 GB+。
 *
 * 规则：
 *   - 默认删 48 小时前的条目（mtime 判定，`--hours=24` 可改，`--all` 连新鲜的也删）；
 *   - 只认 rein- 前缀，其他程序的临时文件一概不碰；
 *   - 单个条目删不掉（正被占用等）只记一笔，不影响其余条目；
 *   - 本脚本永远以 0 退出——挂在 npm pre-hook 上不能阻断开发启动。
 *
 * 用法：`npm run sweep-temp`，或 `node scripts/sweep-temp.mjs --dry-run`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'rein-'

function parseArgs() {
  const opts = { hours: 48, all: false, dryRun: false }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--all') opts.all = true
    else if (arg === '--dry-run') opts.dryRun = true
    else {
      const m = arg.match(/^--hours=(\d+(?:\.\d+)?)$/)
      if (m) opts.hours = Number(m[1])
    }
  }
  return opts
}

/** 递归累计目录字节数（删除前先记账，报告里要知道省了多少） */
function sizeOf(entryPath) {
  let total = 0
  const walk = (dir) => {
    let children
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      try {
        if (child.isDirectory()) walk(path.join(dir, child.name))
        else total += fs.statSync(path.join(dir, child.name)).size
      } catch {
        // 边删边读时条目可能消失，跳过即可
      }
    }
  }
  walk(entryPath)
  return total
}

const mb = (bytes) => Math.round(bytes / 1048576)

const opts = parseArgs()
const tempDir = process.env.TEMP || os.tmpdir()

console.log(`temp-sweep start temp=${tempDir} olderThanHours=${opts.hours} all=${opts.all} dryRun=${opts.dryRun}`)

let entries
try {
  entries = fs.readdirSync(tempDir, { withFileTypes: true })
} catch (err) {
  console.log(`temp-sweep error 读不了临时目录：${err.message}`)
  process.exit(0)
}

const now = Date.now()
let deleted = 0
let failed = 0
let kept = 0
let freed = 0

for (const entry of entries) {
  if (!entry.name.startsWith(PREFIX)) continue
  const full = path.join(tempDir, entry.name)

  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    continue // 扫描期间就消失的，无需处理
  }

  const ageHours = (now - stat.mtimeMs) / 3600000
  if (!opts.all && ageHours < opts.hours) {
    kept += 1
    continue
  }

  const bytes = sizeOf(full)
  if (opts.dryRun) {
    console.log(`temp-sweep would-remove ${entry.name}（${Math.round(ageHours)}h 前，${mb(bytes)} MB）`)
    continue
  }

  try {
    fs.rmSync(full, { recursive: true, force: true })
    deleted += 1
    freed += bytes
    console.log(`temp-sweep removed ${entry.name}（${Math.round(ageHours)}h 前，${mb(bytes)} MB）`)
  } catch (err) {
    failed += 1
    console.log(`temp-sweep failed ${entry.name}：${err.code || err.message}`)
  }
}

console.log(`temp-sweep done 删除 ${deleted} 项释放 ${mb(freed)} MB，保留 ${kept} 项（${opts.hours}h 内），失败 ${failed} 项`)
process.exit(0)

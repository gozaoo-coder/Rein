#!/usr/bin/env node
/**
 * 拉一张 HEIC 样例到 `src-tauri/resources/test/heic/sample.heic`，
 * 只为跑 `cargo test --lib media::wic` 那一条 WIC 解码用例。
 *
 * 这份第三方图片**故意不入库**（约 290KB 二进制、授权不明），同样境地
 * 略过 ⇒ 那条用例会打印提示并跳过（跳过不是通过）。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src-tauri',
  'resources',
  'test',
  'heic',
  'sample.heic',
)

// filesamples.com 的公开样例：HEVC + 内嵌缩略图，1440×960，跟 iPhone 的 HEIC 同构
const SRC = 'https://filesamples.com/samples/image/heic/sample1.heic'

const exists = await stat(target).catch(() => null)
if (exists && exists.size > 0) {
  console.log(`样例已存在：${target}（${exists.size} 字节）`)
  process.exit(0)
}

const res = await fetch(SRC)
if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`)
const bytes = Buffer.from(await res.arrayBuffer())
// 顺手验一下确实是 HEIF 容器（ftyp + heic 家族品牌），别把 HTML 错误页当图片存进去
const brand = bytes.subarray(8, 12).toString('latin1')
if (bytes.subarray(4, 8).toString('latin1') !== 'ftyp' || !/^(heic|heix|mif1|msf1)$/.test(brand)) {
  throw new Error(`解到的不是一个 HEIF 文件：ftyp 品牌为 ${brand}`)
}
await mkdir(dirname(target), { recursive: true })
await writeFile(target, bytes)
console.log(`已写入 ${target}（${bytes.length} 字节）`)

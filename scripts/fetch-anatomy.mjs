/**
 * 拉取 BodyParts3D 网格到 resources/anatomy/meshes/（不入库，构建前跑一次）。
 *
 * 归档 isa_BP3D_4.0_obj_99.zip 有 136 MB / 2234 个 OBJ，但本项目只需要其中
 * ~180 个。ZIP 支持 Range 请求，因此这里先取中央目录拿到每个条目的偏移，
 * 再按需 range 取「本地头 + 压缩数据」，inflate 后落盘 —— 实际流量约 15 MB。
 *
 * 数据：BodyParts3D 4.0（IS-A 树，削减率 99%）
 *   https://dbarchive.biosciencedbc.jp/jp/bodyparts3d/download.html
 * 许可：CC BY 4.0（署名见 resources/muscles/SOURCE.md）
 *
 * 用法：node scripts/fetch-anatomy.mjs [--force]
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync, statSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {inflateRawSync} from 'node:zlib'

import {allMeshIds} from './anatomy/taxonomy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'resources', 'anatomy', 'meshes')
const ZIP_URL = 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip'

const force = process.argv.includes('--force')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 带退避重试的 Range GET */
async function rangeGet(start, end, attempts = 5) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(ZIP_URL, {headers: {Range: `bytes=${start}-${end}`}})
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
      if (i < attempts) await sleep(600 * i)
    }
  }
  throw lastErr
}

/** 解析 ZIP 中央目录：条目名 → {本地头偏移, 压缩大小, 压缩方式} */
async function readCentralDirectory() {
  const head = await fetch(ZIP_URL, {method: 'HEAD'})
  if (!head.ok) throw new Error(`HEAD 失败：HTTP ${head.status}`)
  const size = Number(head.headers.get('content-length'))
  if (!Number.isFinite(size)) throw new Error('响应缺少 content-length')

  const tailLen = Math.min(66_000, size)
  const tail = await rangeGet(size - tailLen, size - 1)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录结尾记录')

  const count = tail.readUInt16LE(eocd + 10)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  const cd = await rangeGet(cdOffset, cdOffset + cdSize - 1)

  const entries = new Map()
  let p = 0
  while (p < cd.length - 4 && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10)
    const compSize = cd.readUInt32LE(p + 20)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const localOff = cd.readUInt32LE(p + 42)
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.set(name.split('/').pop().replace(/\.obj$/, ''), {method, compSize, localOff, name})
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.size !== count) console.warn(`  ! 中央目录条目数不符（声明 ${count}，解析 ${entries.size}）`)
  return entries
}

/** 从归档取单个网格并解压成 OBJ 文本。
 *  本地头（30B + 文件名 + 扩展区）与压缩数据一次 Range 取回，
 *  归档响应很慢，每多一次往返就多几秒。 */
async function fetchMesh(entry) {
  const headRoom = 1024
  const raw = await rangeGet(entry.localOff, entry.localOff + 30 + headRoom + entry.compSize - 1)
  if (raw.readUInt32LE(0) !== 0x04034b50) throw new Error('本地文件头签名错误')
  const nameLen = raw.readUInt16LE(26)
  const extraLen = raw.readUInt16LE(28)
  const dataStart = 30 + nameLen + extraLen
  if (dataStart + entry.compSize > raw.length) throw new Error('本地头长度超出预留区')
  const data = raw.subarray(dataStart, dataStart + entry.compSize)
  if (entry.method === 0) return data.toString('utf8')
  if (entry.method !== 8) throw new Error(`不支持的压缩方式 ${entry.method}`)
  return inflateRawSync(data).toString('utf8')
}

async function main() {
  const ids = allMeshIds()
  console.log(`BodyParts3D 网格 → ${OUT_DIR}`)
  console.log(`需要 ${ids.length} 个网格（右侧 + M 镜像件）\n`)

  mkdirSync(OUT_DIR, {recursive: true})
  const pending = ids.filter((id) => force || !existsSync(join(OUT_DIR, `${id}.obj`)))
  const cached = ids.length - pending.length
  if (cached) console.log(`  ✓ 已缓存 ${cached} 个`)
  if (!pending.length) {
    console.log('\n全部就绪，可以开始构建。')
    return
  }

  console.log('读取归档中央目录…')
  const entries = await readCentralDirectory()
  console.log(`归档内 ${entries.size} 个网格\n`)

  const missing = []
  let done = 0
  let skipped = 0
  let bytes = 0

  // 归档响应约 5–10 s/次，串行要十几分钟；4 路并发把墙钟压到 1/4 左右
  const CONCURRENCY = 4
  const queue = [...pending]
  async function worker() {
    for (;;) {
      const id = queue.shift()
      if (!id) return
      const entry = entries.get(id)
      // 归档里本来就没有的件（中线结构、皮肤等没有 M 镜像件）直接跳过
      if (!entry) {
        skipped += 1
        continue
      }
      try {
        const text = await fetchMesh(entry)
        writeFileSync(join(OUT_DIR, `${id}.obj`), text)
        bytes += text.length
        done += 1
        process.stdout.write(`\r  ${done}/${pending.length - skipped}  (${(bytes / 1024 / 1024).toFixed(1)} MB)   `)
      } catch (e) {
        missing.push(`${id}（${e.message}）`)
      }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker))
  process.stdout.write('\n')
  if (skipped) console.log(`  · ${skipped} 个 id 归档内不存在（中线结构/皮肤无镜像件），已跳过`)

  if (missing.length) {
    console.log(`\n  ! ${missing.length} 个网格未能取得：`)
    for (const m of missing.slice(0, 20)) console.log(`      ${m}`)
    throw new Error('网格不完整')
  }
  const total = ids.reduce((s, id) => s + (existsSync(join(OUT_DIR, `${id}.obj`)) ? statSync(join(OUT_DIR, `${id}.obj`)).size : 0), 0)
  console.log(`\n完成：${ids.length} 个网格，${(total / 1024 / 1024).toFixed(1)} MB。`)
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
})

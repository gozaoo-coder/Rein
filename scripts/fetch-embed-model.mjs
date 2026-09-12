/**
 * 拉取端侧 embedding 模型（bge-small-zh-v1.5，int8 动态量化 ONNX）到 src-tauri/resources/models/。
 *
 * 产出会由 build.rs 校验、由 include_bytes! 编进二进制，所以**不需要随应用分发**：
 * 本目录在 .gitignore 里，克隆仓库后先跑一次本脚本再构建。
 *
 * 用法：node scripts/fetch-embed-model.mjs [--force]
 */
import { existsSync, mkdirSync, openSync, closeSync, writeSync, renameSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src-tauri', 'resources', 'models', 'bge-small-zh-v1.5')

/* 源按实测速度排序：ModelScope 镜像完整且约 4.4 MB/s，hf-mirror 约 0.1 MB/s 且会中途断流，
   huggingface.co 国内直连不通（DNS 失败）。按序回退，失败的文件可跨源续传。 */
const REPO = 'Xenova/bge-small-zh-v1.5'
const SOURCES = [
  {
    host: 'modelscope.cn',
    url: (repoPath) =>
      `https://modelscope.cn/api/v1/models/${REPO}/repo?Revision=master&FilePath=${encodeURIComponent(repoPath)}`,
  },
  { host: 'hf-mirror.com', url: (repoPath) => `https://hf-mirror.com/${REPO}/resolve/main/${repoPath}` },
  { host: 'huggingface.co', url: (repoPath) => `https://huggingface.co/${REPO}/resolve/main/${repoPath}` },
]

/** 需要落盘的文件。repoPath 是仓库内路径，name 是本地扁平文件名；size 用于完整性校验。 */
const FILES = [
  { repoPath: 'onnx/model_quantized.onnx', name: 'model_quantized.onnx', size: 24010842, required: true },
  { repoPath: 'tokenizer.json', name: 'tokenizer.json', size: 439125, required: true },
  { repoPath: 'config.json', name: 'config.json', size: 716, required: true },
]

const force = process.argv.includes('--force')

function fmt(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 可续传下载：以 Range 请求从已有 .part 的偏移继续，断流后退避重试。
 * 镜像对 23MB 的文件会中途断连（实测 1.4MB 处 terminated），一次性下载不可靠。
 */
async function download(url, dest, expectedSize) {
  const MAX_ATTEMPTS = 8
  let lastErr = ''
  let lastWritten = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let offset = existsSync(dest) ? statSync(dest).size : 0
    if (offset > expectedSize) {
      rmSync(dest, { force: true })
      offset = 0
    }
    if (offset === expectedSize) return

    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      })
      // 206 = 服务端接受了续传；200 = 服务端忽略了 Range，从头来
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
      if (res.status === 200 && offset > 0) {
        rmSync(dest, { force: true })
        offset = 0
      }
      if (!res.body) throw new Error('响应无 body')

      let written = offset
      let lastTick = 0
      const fd = openSync(dest, offset > 0 ? 'a' : 'w')
      try {
        for await (const chunk of res.body) {
          writeSync(fd, chunk)
          written += chunk.length
          const now = Date.now()
          if (now - lastTick > 500) {
            lastTick = now
            process.stdout.write(`\r    ${fmt(written)} (${((written / expectedSize) * 100).toFixed(0)}%)   `)
          }
        }
      } finally {
        closeSync(fd)
      }
      lastWritten = written
      if (written === expectedSize) {
        process.stdout.write(`\r    ${fmt(written)} (100%)   \n`)
        return
      }
      lastErr = `连接提前结束（${fmt(written)}/${fmt(expectedSize)}）`
    } catch (e) {
      lastErr = e.message
    }

    if (attempt < MAX_ATTEMPTS) {
      process.stdout.write(`\r    重试 ${attempt}/${MAX_ATTEMPTS - 1}：${lastErr}   \n`)
      await sleep(1000 * attempt)
    }
  }
  throw new Error(`${lastErr}（已续传到 ${fmt(lastWritten)}，重试 ${MAX_ATTEMPTS} 次仍失败）`)
}

async function fetchOne(file) {
  const dest = join(outDir, file.name)

  if (!force && existsSync(dest)) {
    const have = statSync(dest).size
    if (have === file.size) {
      console.log(`  ✓ ${file.name} 已存在（${fmt(have)}）`)
      return
    }
    console.log(`  ! ${file.name} 大小不符（期望 ${file.size}，实际 ${have}），重新拉取`)
  }

  const errors = []
  for (const src of SOURCES) {
    const url = src.url(file.repoPath)
    const part = `${dest}.part`
    try {
      console.log(`  · ${file.name} ← ${src.host}`)
      await download(url, part, file.size)
      renameSync(part, dest)
      console.log(`  ✓ ${file.name}`)
      return
    } catch (e) {
      // 不删 .part：同一文件换源可继续续传
      errors.push(`${src.host}: ${e.message}`)
      console.log(`    ✗ ${e.message}`)
    }
  }
  throw new Error(`${file.name} 全部源均失败：\n    ${errors.join('\n    ')}`)
}

async function main() {
  console.log(`拉取端侧 embedding 模型 → ${outDir}`)
  mkdirSync(outDir, { recursive: true })

  for (const f of FILES) {
    try {
      await fetchOne(f)
    } catch (e) {
      if (f.required) throw e
      console.log(`  （可选文件跳过：${f.name}）`)
    }
  }

  const total = FILES.reduce((s, f) => s + (existsSync(join(outDir, f.name)) ? statSync(join(outDir, f.name)).size : 0), 0)
  console.log(`\n完成，合计 ${fmt(total)}。可以开始构建。`)
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
})

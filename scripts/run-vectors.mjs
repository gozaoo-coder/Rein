/**
 * 跑步采集向量表 —— TS 镜像 runner。
 *
 * 用与 Kotlin `RunAutoPause.selfTest()` / Rust `model.rs::spec::run_vectors()` **同一张**
 * 向量表（V1..V21）打在 web 侧纯逻辑 `src/stores/runGate.ts` 上：桌面 / 浏览器 / 原生
 * 降级后的 web 采集路径就是这份代码，所以这里通过 = TS 镜像与 Kotlin/Rust 同表同值。
 *
 * 运行：node scripts/run-vectors.mjs
 * 退出码：全 pass → 0；任一 FAIL → 1。
 *
 * 无额外 flag：Node 26 原生支持直接 import .ts（类型擦除），runGate.ts 也刻意做成
 * 零依赖纯逻辑（无 Vue / pinia / window / '@/...' 别名），所以这条命令开箱即跑。
 */
import { runVectors } from '../src/stores/runGate.ts'

const results = runVectors()

let failed = 0
for (const r of results) {
  const tag = r.ok ? 'pass' : 'FAIL'
  if (!r.ok) failed++
  console.log(`${tag} ${r.name} — ${r.detail}`)
}
const passed = results.length - failed
console.log(`apvector pass=${passed} fail=${failed}`)
process.exit(failed === 0 ? 0 : 1)

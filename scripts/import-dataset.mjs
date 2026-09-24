#!/usr/bin/env node
/**
 * 把 exercises-dataset（MIT 数据）的**精选子集**转成 Rein 的动作目录。
 *
 * 产物两份：
 *   1. `scripts/catalog/dataset.mjs` —— 生成物，随仓库提交；由 gen-exercises.mjs 合并进种子。
 *   2. `resources/_review/dataset-review.json` —— 评审草稿（gitignore）：每条含
 *      自动推导的肌群草稿 vs 精选表里的评审结果、数据集的中文分步说明、原始字段。
 *      人工过审后才把结论写回 `scripts/catalog/dataset-selection.mjs`。
 *
 * 明确不做：不引入媒体（© Gym visual）、不用英语名做展示名、不用数据集的粗粒度
 * target/secondary 直接覆盖 Rein 的肌群档位（那会把上/下胸、三角肌三束抹平）。
 *
 * 用法：
 *   node scripts/import-dataset.mjs --src <exercises.json 路径>
 *   node scripts/import-dataset.mjs --src ./resources/_dataset/exercises.json --limit 5
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MUSCLE_KEYS, isMuscleKey } from '../src/config/muscles.ts'
import { SELECTION } from './catalog/dataset-selection.mjs'
import { draftActivation } from './catalog/muscle-terms.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 器材：数据集词 → Rein 枚举（kettlebell / leverage machine 等归到最接近的档） */
const EQUIPMENT_MAP = {
  barbell: 'barbell',
  'ez barbell': 'barbell',
  dumbbell: 'dumbbell',
  cable: 'cable',
  'leverage machine': 'machine',
  'smith machine': 'machine',
  'sled machine': 'machine',
  'body weight': 'bodyweight',
  band: 'band',
  'resistance band': 'band',
  kettlebell: 'other',
  cardio: 'cardio',
}

const STEP_BY_EQUIPMENT = {
  barbell: 2.5,
  dumbbell: 2,
  machine: 2.5,
  cable: 2.5,
  bodyweight: 0,
  band: 1,
  other: 1,
}

const REST_BY_EQUIPMENT = {
  barbell: 120,
  dumbbell: 90,
  machine: 90,
  cable: 75,
  bodyweight: 60,
  band: 60,
  other: 90,
}

const MAX_STEPS = 12
const MAX_STEP_CHARS = 200
const MAX_TIP_CHARS = 120

function parseArgs(argv) {
  const args = { src: '', limit: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--src') args.src = argv[++i] ?? ''
    else if (a === '--limit') args.limit = Number(argv[++i] ?? 0)
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** 中文分步说明：优先 instruction_steps.zh，缺失时按句子切 instructions.zh */
function chineseSteps(entry) {
  const list = entry.instruction_steps?.zh
  const raw = Array.isArray(list) && list.length ? list : String(entry.instructions?.zh ?? '').split(/[。；;]\s*/)
  return raw
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS)
    .map((s) => s.slice(0, MAX_STEP_CHARS))
}

/** 机器翻译的说明不适合直接当要诀：只用作草稿第一句，最终以精选表的 tips 为准 */
function draftTip(entry) {
  const first = chineseSteps(entry)[0] ?? ''
  return first.length <= MAX_TIP_CHARS ? first : `${first.slice(0, MAX_TIP_CHARS - 1)}…`
}

function slugOf(englishName) {
  return String(englishName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48)
}

function validateMuscles(name, muscles) {
  for (const [key, level] of Object.entries(muscles)) {
    if (!isMuscleKey(key)) throw new Error(`动作「${name}」的肌群键非法：${key}`)
    if (level !== 1 && level !== 2 && level !== 3) {
      throw new Error(`动作「${name}」的肌群「${key}」档位非法：${level}`)
    }
  }
  if (!Object.keys(muscles).length) throw new Error(`动作「${name}」没有肌群表`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.src) {
    console.log('用法：node scripts/import-dataset.mjs --src <exercises.json 路径> [--limit N]')
    process.exit(args.help ? 0 : 1)
  }
  const src = path.resolve(process.cwd(), args.src)
  if (!fs.existsSync(src)) {
    console.error(`找不到数据集文件：${src}`)
    console.error('可先下载：curl -L -o resources/_dataset/exercises.json \\')
    console.error('  https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json')
    process.exit(1)
  }

  const dataset = JSON.parse(fs.readFileSync(src, 'utf8'))
  const byId = new Map(dataset.map((e) => [e.id, e]))

  const ids = Object.keys(SELECTION)
  const picked = args.limit > 0 ? ids.slice(0, args.limit) : ids

  const entries = []
  const review = []
  const names = new Set()

  for (const id of picked) {
    const selection = SELECTION[id]
    const raw = byId.get(id)
    if (!raw) {
      throw new Error(`数据集里没有 id=${id}（精选表引用了不存在的条目）`)
    }
    const equipment = EQUIPMENT_MAP[raw.equipment]
    if (!equipment) throw new Error(`动作「${raw.name}」的器材未映射：${raw.equipment}`)
    const name = selection.name?.trim()
    if (!name) throw new Error(`精选表缺中文名：id=${id}（数据集名 ${raw.name}）`)
    if (names.has(name)) throw new Error(`精选表里中文名重复：${name}`)
    names.add(name)

    const draft = draftActivation(raw)
    const muscles = selection.muscles ?? draft
    validateMuscles(name, muscles)

    const steps = chineseSteps(raw)
    const tips = (selection.tips ?? draftTip(raw)).slice(0, MAX_TIP_CHARS)

    entries.push({
      id: slugOf(raw.name),
      name,
      aliases: selection.aliases ?? [],
      kind: 'strength',
      category: selection.category,
      equipment,
      muscles,
      tips,
      steps,
      defaultSets: selection.sets ?? 3,
      defaultReps: selection.reps ?? 10,
      defaultWeightKg: null,
      defaultRestSec: selection.rest ?? REST_BY_EQUIPMENT[equipment] ?? 90,
      weightStep: STEP_BY_EQUIPMENT[equipment] ?? 1,
      datasetId: raw.id,
      datasetName: raw.name,
    })

    review.push({
      id: raw.id,
      datasetName: raw.name,
      reinName: name,
      reinId: entries[entries.length - 1].id,
      equipment: { dataset: raw.equipment, rein: equipment },
      datasetMuscles: {
        target: raw.target,
        muscle_group: raw.muscle_group,
        secondary: raw.secondary_muscles ?? [],
      },
      draftMuscles: draft,
      reviewedMuscles: muscles,
      reviewedBySelectionTable: Boolean(selection.muscles),
      draftTip: draftTip(raw),
      tip: tips,
      stepsZh: steps,
      zhInstructionsSource: 'machine-translated (dataset)',
      media: { skipped: true, reason: '© Gym visual, 需自行取得授权' },
    })
  }

  const unknownKeys = new Set()
  for (const e of entries) {
    for (const key of Object.keys(e.muscles)) if (!MUSCLE_KEYS.includes(key)) unknownKeys.add(key)
  }
  if (unknownKeys.size) throw new Error(`出现未知肌群键：${[...unknownKeys].join('、')}`)

  // 1) 生成数据集目录（提交物）
  const outFile = path.join(root, 'scripts', 'catalog', 'dataset.mjs')
  const body = entries
    .map((e) => {
      const { datasetId, datasetName, ...rest } = e
      return `  // ${datasetId} · ${datasetName}\n  ${JSON.stringify(rest)},`
    })
    .join('\n')
  fs.writeFileSync(
    outFile,
    `/**
 * 【生成物】exercises-dataset 精选子集 → Rein 动作目录。
 *
 * 由 \`node scripts/import-dataset.mjs\` 从 scripts/catalog/dataset-selection.mjs
 * 生成，**不要手改**：改精选表后重跑导入与 gen-exercises.mjs。
 * 数据许可：MIT（exercises-dataset）；媒体未引入（© Gym visual）。
 *
 * 共 ${entries.length} 条：
 */
export const DATASET_EXERCISES = [
${body}
]
`,
    'utf8',
  )

  // 2) 评审草稿（不提交）
  const reviewDir = path.join(root, 'resources', '_review')
  fs.mkdirSync(reviewDir, { recursive: true })
  const reviewFile = path.join(reviewDir, 'dataset-review.json')
  fs.writeFileSync(reviewFile, JSON.stringify({ generatedAt: new Date().toISOString(), src, entries: review }, null, 2), 'utf8')

  console.log(`已写入 ${path.relative(root, outFile)}：${entries.length} 个动作`)
  console.log(`评审草稿 ${path.relative(root, reviewFile)}（人工过审后回填 dataset-selection.mjs）`)
  const unReviewed = review.filter((r) => !r.reviewedBySelectionTable).map((r) => r.reinName)
  if (unReviewed.length) {
    console.warn(`注意：以下条目仍在用自动草稿肌群表，请人工复核：${unReviewed.join('、')}`)
  }
}

main()

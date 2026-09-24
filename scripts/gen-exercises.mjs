#!/usr/bin/env node
/**
 * 生成动作库种子 `resources/exercises.json`。
 *
 * 单一来源：动作的默认处方（组数/次数/重量/时长/休息）与动作要点取自
 * `resources/workout_plans.json` 里该动作第一次出现的位置；**肌群激活表必须
 * 在 SPEC 里显式手写**（曾用 `resolveActivation` 按名字推导，粒度粗且会把
 * 「罗马尼亚硬拉」和「硬拉」按同一张表处理，已废弃）。关键词规则只留给
 * 用户自建动作在前端兜底展示，不再参与内置数据生成。
 *
 * 硬约束（任一不满足即 throw，宁可生成失败也不要错误数据）：
 *   - 每条 SPEC 必须给 `m`（柔韧/放松类给 `m: {}`）且不得为空表以外的非法值
 *   - 肌群键必须属于 MUSCLE_KEYS，档位只能是 1 / 2 / 3
 *   - id / 动作名唯一；课程种子里的每个动作都必须能在库里命中；tips 非空
 *
 * 手写部分只有 SPEC 表：id / 分类 / 器材 / 别名 / 重量步进 / 肌群表 /
 * 少量补充动作的处方与要点。新增一个内置动作 = 在 SPEC 加一行并重跑本脚本。
 *
 * 用法：node scripts/gen-exercises.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MUSCLE_GROUPS, MUSCLE_KEYS, isMuscleKey } from '../src/config/muscles.ts'
import { DATASET_EXERCISES } from './catalog/dataset.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 器材 → 建议重量取整步进（kg）：杠铃片 2.5 的倍数 / 哑铃 2 / 自重不加重量 */
const STEP_BY_EQUIPMENT = {
  barbell: 2.5,
  dumbbell: 2,
  machine: 2.5,
  cable: 2.5,
  bodyweight: 0,
  band: 1,
  cardio: 0,
  other: 1,
}

/* ------------------------------------------------------- 共用肌群表
 * 同一动作的各种变体共用一张表，改一处即全变体同步。
 * 档位：3 主攻 / 2 辅助 / 1 稳定。
 */

/** 蹲类（深蹲 / 弓步 / 保加利亚 / 靠墙静蹲）：股四头 + 臀主导，腘绳/内收/小腿稳定 */
const SQUAT = {
  'quads-rec': 3,
  'quads-lat': 2,
  'quads-med': 2,
  'vastus-intermedius': 2,
  'glute-max': 3,
  'glute-med': 2,
  hamstrings: 2,
  adductors: 2,
  'quadratus-femoris': 1,
  'lower-back': 1,
  abs: 1,
  calves: 1,
}

/** 水平拉（杠铃/绳索/哑铃划船）：背阔 + 大圆肌 + 菱形肌，二头与握力真实参与 */
const ROW = {
  lats: 3,
  'teres-major': 2,
  rhomboids: 2,
  'traps-mid': 2,
  'delt-post': 2,
  'traps-low': 2,
  biceps: 2,
  forearm: 2,
  'lower-back': 1,
}

/** 垂直拉（引体 / 高位下拉） */
const PULLDOWN = {
  lats: 3,
  'teres-major': 2,
  'traps-mid': 2,
  'delt-post': 2,
  'traps-low': 2,
  biceps: 2,
  forearm: 2,
  'lower-back': 1,
}

/** 跑类（慢跑 / 间歇）：踝背屈与髋外展稳定都实打实参与，髂腰肌负责摆腿 */
const RUN = {
  'quads-rec': 2,
  'quads-lat': 2,
  hamstrings: 2,
  'glute-max': 2,
  'glute-med': 2,
  iliopsoas: 2,
  calves: 3,
  soleus: 2,
  tibialis: 2,
  abs: 1,
}

/** 提踵（直膝 / 屈膝）：胫骨后肌与腓骨肌群负责踝的稳定 */
const CALF = {
  calves: 3,
  soleus: 2,
  'tibialis-post': 1,
  fibularis: 1,
}

/**
 * 动作库 SPEC。
 *  - n  动作名（必须与课程种子 / 用户口语一致）
 *  - id 稳定 slug（一经发布不可改：重量曲线按它聚合）
 *  - c  分类 push|pull|legs|core|cardio|mobility|other（浏览分组）
 *  - eq 器材
 *  - a  别名（旧数据按名匹配时的补充命中词）
 *  - step 重量步进覆盖（缺省按器材）
 *  - m  肌群激活表（必填；柔韧类显式给 {}）
 *  - d/tips 仅「不在课程种子里」的补充动作需要：处方与要点
 */
const SPEC = [
  // ---- 推 · 胸 / 肩 / 三头 ----
  {
    n: '杠铃卧推',
    id: 'barbell-bench-press',
    c: 'push',
    eq: 'barbell',
    a: ['卧推', '平板卧推'],
    m: { 'chest-low': 3, 'chest-up': 2, triceps: 2, 'delt-ant': 2, abs: 1 },
  },
  {
    n: '上斜哑铃卧推',
    id: 'incline-dumbbell-press',
    c: 'push',
    eq: 'dumbbell',
    a: ['上斜卧推'],
    m: { 'chest-up': 3, 'chest-low': 1, 'delt-ant': 2, triceps: 2 },
  },
  {
    n: '坐姿哑铃肩推',
    id: 'seated-dumbbell-shoulder-press',
    c: 'push',
    eq: 'dumbbell',
    a: ['哑铃肩推', '坐姿推举'],
    m: {
      'delt-ant': 3,
      'delt-lat': 2,
      triceps: 2,
      'serratus-ant': 2,
      'traps-up': 1,
      'traps-low': 1,
      'delt-post': 1,
      abs: 1,
    },
  },
  {
    n: '哑铃侧平举',
    id: 'dumbbell-lateral-raise',
    c: 'push',
    eq: 'dumbbell',
    a: ['侧平举'],
    m: { 'delt-lat': 3, 'traps-up': 1 },
  },
  {
    n: '蝴蝶机夹胸',
    id: 'peck-deck-fly',
    c: 'push',
    eq: 'machine',
    a: ['器械夹胸', '龙门架夹胸'],
    m: { 'chest-low': 3, 'chest-up': 2, 'delt-ant': 1 },
  },
  {
    n: '绳索下压',
    id: 'cable-pushdown',
    c: 'push',
    eq: 'cable',
    a: ['三头下压'],
    m: { triceps: 3, forearm: 1 },
  },
  {
    n: '颈后绳索臂屈伸',
    id: 'overhead-cable-extension',
    c: 'push',
    eq: 'cable',
    a: ['过顶臂屈伸'],
    m: { triceps: 3, forearm: 1 },
  },
  {
    n: '俯卧撑',
    id: 'push-up',
    c: 'push',
    eq: 'bodyweight',
    m: { 'chest-low': 3, 'chest-up': 2, triceps: 2, 'delt-ant': 2, abs: 2, 'glute-max': 1 },
  },
  {
    n: '下斜俯卧撑（脚垫高）',
    id: 'decline-push-up',
    c: 'push',
    eq: 'bodyweight',
    a: ['下斜俯卧撑'],
    m: { 'chest-up': 3, 'chest-low': 1, 'delt-ant': 2, triceps: 2, abs: 1 },
  },
  {
    n: '椅式臂屈伸',
    id: 'bench-dip',
    c: 'push',
    eq: 'bodyweight',
    a: ['凳上臂屈伸'],
    m: { triceps: 3, 'chest-low': 2, 'delt-ant': 2, abs: 1 },
  },
  // ---- 拉 · 背 / 二头 / 前臂 / 后束 ----
  {
    n: '引体向上',
    id: 'pull-up',
    c: 'pull',
    eq: 'bodyweight',
    a: ['引体'],
    m: { ...PULLDOWN, abs: 1 },
  },
  {
    n: '杠铃划船',
    id: 'barbell-row',
    c: 'pull',
    eq: 'barbell',
    m: ROW,
  },
  {
    n: '坐姿绳索划船',
    id: 'seated-cable-row',
    c: 'pull',
    eq: 'cable',
    a: ['绳索划船'],
    m: ROW,
  },
  {
    n: '直臂下拉',
    id: 'straight-arm-pulldown',
    c: 'pull',
    eq: 'cable',
    m: { lats: 3, 'teres-major': 2, 'traps-mid': 2, 'delt-post': 2, 'traps-low': 2, abs: 1 },
  },
  {
    n: '高位下拉',
    id: 'lat-pulldown',
    c: 'pull',
    eq: 'cable',
    a: ['下拉'],
    m: PULLDOWN,
  },
  {
    n: '杠铃耸肩',
    id: 'barbell-shrug',
    c: 'pull',
    eq: 'barbell',
    a: ['耸肩'],
    m: { 'traps-up': 3, 'levator-scapulae': 2, forearm: 2 },
  },
  {
    n: '面拉',
    id: 'face-pull',
    c: 'pull',
    eq: 'cable',
    m: { 'delt-post': 3, 'rotator-cuff': 3, 'traps-mid': 2, 'traps-low': 2 },
  },
  {
    n: '俯身反向飞鸟',
    id: 'reverse-fly',
    c: 'pull',
    eq: 'dumbbell',
    a: ['反向飞鸟'],
    m: { 'delt-post': 3, 'traps-mid': 2, rhomboids: 2, 'rotator-cuff': 1, 'traps-low': 1 },
  },
  {
    n: '杠铃弯举',
    id: 'barbell-curl',
    c: 'pull',
    eq: 'barbell',
    a: ['二头弯举'],
    m: { biceps: 3, forearm: 2 },
  },
  {
    n: '锤式弯举',
    id: 'hammer-curl',
    c: 'pull',
    eq: 'dumbbell',
    m: { biceps: 3, forearm: 2 },
  },
  {
    n: '腕弯举',
    id: 'wrist-curl',
    c: 'pull',
    eq: 'dumbbell',
    m: { forearm: 3 },
  },
  {
    n: '反握腕弯举',
    id: 'reverse-wrist-curl',
    c: 'pull',
    eq: 'dumbbell',
    m: { forearm: 3 },
  },
  {
    n: '桌沿反向划船',
    id: 'table-inverted-row',
    c: 'pull',
    eq: 'bodyweight',
    a: ['反向划船'],
    m: { ...ROW, rhomboids: 1 },
  },
  // ---- 腿 · 后链 / 小腿 ----
  {
    n: '杠铃深蹲',
    id: 'barbell-squat',
    c: 'legs',
    eq: 'barbell',
    a: ['深蹲', '背蹲'],
    m: SQUAT,
  },
  {
    n: '罗马尼亚硬拉',
    id: 'romanian-deadlift',
    c: 'legs',
    eq: 'barbell',
    a: ['RDL'],
    m: {
      hamstrings: 3,
      'glute-max': 3,
      'lower-back': 3,
      'glute-med': 1,
      abs: 1,
      lats: 2,
      'traps-up': 2,
      forearm: 2,
    },
  },
  {
    n: '保加利亚分腿蹲',
    id: 'bulgarian-split-squat',
    c: 'legs',
    eq: 'dumbbell',
    a: ['保加利亚蹲'],
    m: SQUAT,
  },
  {
    n: '坐姿腿弯举',
    id: 'seated-leg-curl',
    c: 'legs',
    eq: 'machine',
    a: ['腿弯举'],
    m: { hamstrings: 3, popliteus: 1, calves: 1 },
  },
  {
    n: '腿屈伸',
    id: 'leg-extension',
    c: 'legs',
    eq: 'machine',
    a: ['坐姿腿屈伸'],
    m: { 'quads-rec': 3, 'quads-lat': 2, 'quads-med': 2, 'vastus-intermedius': 2 },
  },
  {
    n: '站姿提踵',
    id: 'standing-calf-raise',
    c: 'legs',
    eq: 'machine',
    a: ['站姿提踵'],
    m: CALF,
  },
  {
    n: '坐姿提踵',
    id: 'seated-calf-raise',
    c: 'legs',
    eq: 'machine',
    m: { soleus: 3, calves: 1, 'tibialis-post': 1, fibularis: 1 },
  },
  {
    n: '反向弓步',
    id: 'reverse-lunge',
    c: 'legs',
    eq: 'bodyweight',
    a: ['弓步蹲'],
    m: SQUAT,
  },
  {
    n: '臀桥',
    id: 'glute-bridge',
    c: 'legs',
    eq: 'bodyweight',
    m: { 'glute-max': 3, 'glute-med': 2, 'glute-min': 1, hamstrings: 2, abs: 1 },
  },
  {
    n: '徒手深蹲',
    id: 'bodyweight-squat',
    c: 'legs',
    eq: 'bodyweight',
    a: ['自重深蹲'],
    m: SQUAT,
  },
  {
    n: '保加利亚分腿蹲（自重）',
    id: 'bodyweight-bulgarian-split-squat',
    c: 'legs',
    eq: 'bodyweight',
    m: SQUAT,
  },
  {
    n: '单腿臀桥',
    id: 'single-leg-glute-bridge',
    c: 'legs',
    eq: 'bodyweight',
    m: { 'glute-max': 3, 'glute-med': 3, 'glute-min': 1, hamstrings: 2, abs: 1 },
  },
  {
    n: '提踵',
    id: 'calf-raise',
    c: 'legs',
    eq: 'bodyweight',
    m: CALF,
  },
  {
    n: '靠墙静蹲',
    id: 'wall-sit',
    c: 'legs',
    eq: 'bodyweight',
    m: {
      'quads-rec': 3,
      'quads-lat': 2,
      'quads-med': 2,
      'vastus-intermedius': 2,
      'glute-max': 1,
      abs: 1,
    },
  },
  {
    n: '深蹲跳',
    id: 'squat-jump',
    c: 'legs',
    eq: 'bodyweight',
    m: {
      'quads-rec': 3,
      'quads-lat': 2,
      'quads-med': 2,
      'vastus-intermedius': 2,
      'glute-max': 3,
      'glute-med': 2,
      hamstrings: 2,
      calves: 3,
      soleus: 2,
      tibialis: 1,
      plantaris: 1,
      abs: 1,
    },
  },
  // ---- 核心 ----
  {
    n: '平板支撑',
    id: 'plank',
    c: 'core',
    eq: 'bodyweight',
    a: ['平板'],
    m: { abs: 3, obliques: 2, 'serratus-ant': 2, 'glute-max': 1 },
  },
  {
    n: '死虫式',
    id: 'dead-bug',
    c: 'core',
    eq: 'bodyweight',
    a: ['死虫'],
    m: { abs: 3, obliques: 2, iliopsoas: 1 },
  },
  {
    n: '悬垂举腿',
    id: 'hanging-leg-raise',
    c: 'core',
    eq: 'bodyweight',
    a: ['举腿'],
    m: { abs: 3, iliopsoas: 2, forearm: 2, lats: 1 },
  },
  // ---- 有氧 / 间歇 ----
  {
    n: '放松跑',
    id: 'easy-run',
    c: 'cardio',
    eq: 'cardio',
    a: ['慢跑', '有氧跑'],
    m: RUN,
  },
  {
    n: '开合跳',
    id: 'jumping-jack',
    c: 'cardio',
    eq: 'bodyweight',
    m: {
      'delt-lat': 3,
      'glute-med': 3,
      calves: 3,
      soleus: 2,
      'quads-rec': 2,
      'glute-max': 2,
      'traps-up': 1,
      tibialis: 1,
      abs: 1,
    },
  },
  {
    n: '波比跳',
    id: 'burpee',
    c: 'cardio',
    eq: 'bodyweight',
    m: {
      'quads-rec': 3,
      'quads-lat': 2,
      'glute-max': 2,
      'glute-med': 1,
      'chest-low': 2,
      'delt-ant': 2,
      triceps: 2,
      abs: 2,
      calves: 2,
      soleus: 2,
      tibialis: 1,
    },
  },
  {
    n: '高抬腿',
    id: 'high-knees',
    c: 'cardio',
    eq: 'bodyweight',
    m: {
      'quads-rec': 3,
      'quads-lat': 2,
      iliopsoas: 2,
      abs: 2,
      calves: 2,
      soleus: 1,
      tibialis: 2,
      'glute-med': 1,
    },
  },
  {
    n: '登山跑',
    id: 'mountain-climber',
    c: 'cardio',
    eq: 'bodyweight',
    m: {
      'quads-rec': 3,
      'quads-lat': 2,
      'glute-max': 2,
      'glute-med': 1,
      iliopsoas: 2,
      'serratus-ant': 2,
      'delt-ant': 1,
      triceps: 1,
      calves: 2,
      tibialis: 1,
      abs: 2,
    },
  },

  // ---- 补充动作（不在课程种子里，处方与要点在此手写）----
  {
    n: '硬拉',
    id: 'deadlift',
    c: 'legs',
    eq: 'barbell',
    a: ['传统硬拉'],
    d: { sets: 3, reps: 5, kg: 80, rest: 180 },
    tips: '全身力量基石：杠贴腿起、髋膝同时伸展，腰背中立不弓不塌，起不来就减重。',
    m: {
      hamstrings: 3,
      'glute-max': 3,
      'lower-back': 3,
      'quads-lat': 2,
      adductors: 2,
      'glute-med': 1,
      abs: 1,
      lats: 2,
      'traps-up': 2,
      forearm: 2,
    },
  },
  {
    n: '上斜杠铃卧推',
    id: 'incline-barbell-press',
    c: 'push',
    eq: 'barbell',
    d: { sets: 3, reps: 8, kg: 45, rest: 90 },
    tips: '主攻上胸；上斜约 30°，肩胛后收，杆触上胸沿再推起。',
    m: { 'chest-up': 3, 'chest-low': 1, 'delt-ant': 2, triceps: 2 },
  },
  {
    n: '双杠臂屈伸',
    id: 'dips',
    c: 'push',
    eq: 'bodyweight',
    d: { sets: 3, reps: 8, rest: 90 },
    tips: '躯干微前倾练胸，直立练三头；沉肩不塌肩，下放到大臂与地面平行。',
    m: { triceps: 3, 'chest-low': 2, 'delt-ant': 2, abs: 1 },
  },
  {
    n: '单臂哑铃划船',
    id: 'one-arm-dumbbell-row',
    c: 'pull',
    eq: 'dumbbell',
    d: { sets: 3, reps: 10, kg: 20, rest: 75 },
    tips: '单侧背部厚度：躯干固定不旋转，肘沿髋方向拉，肩胛先收再屈肘。',
    m: { ...ROW, obliques: 1 },
  },
  {
    n: '站姿杠铃推举',
    id: 'overhead-press',
    c: 'push',
    eq: 'barbell',
    a: ['站姿推举', '推举'],
    d: { sets: 4, reps: 6, kg: 30, rest: 120 },
    tips: '肩部力量基石：核心与臀绷紧不后仰，杠过头顶后落在耳后，轨迹贴身。',
    m: {
      'delt-ant': 3,
      'delt-lat': 2,
      triceps: 2,
      'serratus-ant': 2,
      'traps-up': 1,
      'traps-low': 1,
      'delt-post': 1,
      abs: 1,
    },
  },
  {
    n: '卷腹',
    id: 'crunch',
    c: 'core',
    eq: 'bodyweight',
    a: ['仰卧卷腹'],
    d: { sets: 3, reps: 15, rest: 45 },
    tips: '胸骨向骨盆卷起而非抬头，下背贴地，顶端呼气收缩 1 秒。',
    m: { abs: 3, obliques: 1 },
  },
  {
    n: '侧平板支撑',
    id: 'side-plank',
    c: 'core',
    eq: 'bodyweight',
    kindOverride: 'timed',
    d: { sets: 3, sec: 30, rest: 40 },
    tips: '侧链稳定：肘在肩正下方，髋部顶高成一条直线，两侧各做同样组数。',
    m: { obliques: 3, 'glute-med': 2, abs: 1 },
  },
  {
    n: '罗马椅挺身',
    id: 'back-extension',
    c: 'legs',
    eq: 'bodyweight',
    a: ['山羊挺身'],
    d: { sets: 3, reps: 12, rest: 60 },
    tips: '后链与竖脊肌：髋铰链起落，脊柱保持中立，顶端不要过度后仰。',
    m: { 'lower-back': 3, 'glute-max': 2, hamstrings: 2, abs: 1 },
  },
  {
    n: '椭圆机',
    id: 'elliptical',
    c: 'cardio',
    eq: 'cardio',
    kindOverride: 'cardio',
    d: { sets: 1, min: 20, rest: 0 },
    tips: '低冲击有氧：阻力调到能对话但微喘，脚跟压实踏板。',
    m: { 'quads-rec': 3, 'glute-max': 2, hamstrings: 2, 'glute-med': 1, calves: 1, abs: 1 },
  },
  {
    n: '划船机',
    id: 'rowing-machine',
    c: 'cardio',
    eq: 'cardio',
    kindOverride: 'cardio',
    d: { sets: 1, min: 15, rest: 0 },
    tips: '腿—髋—手臂的顺序发力，回程反向；每 500m 配速稳定优于猛冲。',
    m: {
      lats: 3,
      'teres-major': 2,
      rhomboids: 2,
      'traps-mid': 2,
      'delt-post': 2,
      'traps-low': 2,
      biceps: 2,
      'quads-rec': 2,
      'glute-max': 2,
      hamstrings: 1,
      'lower-back': 1,
      abs: 1,
    },
  },
  {
    n: '动感单车',
    id: 'spin-bike',
    c: 'cardio',
    eq: 'cardio',
    kindOverride: 'cardio',
    d: { sets: 1, min: 25, rest: 0 },
    tips: '坐垫调到髋高，踏频 80-100 rpm，膝盖始终对准脚尖方向。',
    m: { 'quads-rec': 3, 'quads-lat': 2, 'glute-max': 2, hamstrings: 1, calves: 2, soleus: 2 },
  },
  {
    n: '跳绳',
    id: 'jump-rope',
    c: 'cardio',
    eq: 'other',
    kindOverride: 'cardio',
    d: { sets: 5, min: 3, rest: 45 },
    tips: '前脚掌落地、手腕摇绳，落地轻盈；膝踝不适换成原地小跳。',
    m: { 'quads-rec': 2, calves: 3, soleus: 2, tibialis: 2, forearm: 2, 'glute-med': 1, abs: 1 },
  },
  {
    n: '泡沫轴放松',
    id: 'foam-roll',
    c: 'mobility',
    eq: 'other',
    kindOverride: 'timed',
    m: {},
    d: { sets: 1, sec: 300, rest: 0 },
    tips: '每个酸痛点半分钟慢速滚动，不滚腰椎与关节，呼吸放松不憋气。',
  },
  {
    n: '静态拉伸',
    id: 'static-stretch',
    c: 'mobility',
    eq: 'other',
    kindOverride: 'timed',
    m: {},
    tips: '训练后拉伸：每个部位 30 秒，拉到轻微紧绷即可，不弹震不疼痛。',
  },
]

/** 读取课程种子，建立「动作名 → 首次出现的处方与要点」索引 */
function loadPlanMovements() {
  const file = path.join(root, 'resources', 'workout_plans.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const index = new Map()
  for (const plan of data.plans) {
    for (const e of plan.exercises) {
      if (!index.has(e.name)) index.set(e.name, e)
    }
  }
  return index
}

const KIND_BY_CATEGORY = { cardio: 'cardio', mobility: 'timed' }

/**
 * 肌群表校验：键必须在 MUSCLE_KEYS 内、档位只能是 1/2/3；
 * 空表只允许柔韧类（`m: {}` 必须显式写出，漏写即报错）。
 */
function validateMuscles(name, category, m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error(`动作「${name}」缺少显式肌群表 m（柔韧/放松类请写 m: {}）`)
  }
  for (const [key, level] of Object.entries(m)) {
    if (!isMuscleKey(key)) {
      throw new Error(`动作「${name}」的肌群键非法：${key}（不在 MUSCLE_KEYS 内）`)
    }
    if (level !== 1 && level !== 2 && level !== 3) {
      throw new Error(`动作「${name}」的肌群「${key}」档位非法：${level}（应为 1/2/3）`)
    }
  }
  if (!Object.keys(m).length && category !== 'mobility') {
    throw new Error(`动作「${name}」的肌群表为空（只有柔韧类允许 m: {}）`)
  }
  return { ...m }
}

function buildEntry(spec, plans) {
  const inPlans = plans.get(spec.n)
  const kind = inPlans?.kind ?? spec.kindOverride ?? KIND_BY_CATEGORY[spec.c] ?? 'strength'
  const d = spec.d ?? {}
  const sets = inPlans?.sets ?? d.sets ?? 3
  const reps = inPlans?.reps ?? d.reps ?? null
  const weightKg = inPlans?.weightKg ?? d.kg ?? null
  const targetSec = inPlans?.targetSec ?? d.sec ?? null
  const durationMin = inPlans?.durationMin ?? d.min ?? null
  const restSec = inPlans?.restSec ?? d.rest ?? 90
  const tips = inPlans?.tips ?? spec.tips ?? ''
  const muscles = validateMuscles(spec.n, spec.c, spec.m)
  if (!tips) throw new Error(`动作「${spec.n}」缺动作要点`)

  return {
    id: spec.id,
    name: spec.n,
    aliases: spec.a ?? [],
    kind,
    category: spec.c,
    equipment: spec.eq,
    muscles,
    tips,
    steps: validateSteps(spec.n, spec.steps),
    defaultSets: sets,
    defaultReps: kind === 'strength' ? reps : null,
    defaultWeightKg: kind === 'strength' ? weightKg : null,
    defaultTargetSec: kind === 'timed' ? targetSec : null,
    defaultDurationMin: kind === 'cardio' ? durationMin : null,
    defaultRestSec: restSec,
    weightStep: spec.step ?? STEP_BY_EQUIPMENT[spec.eq] ?? 1,
  }
}

/** 数据集导入条目（catalog/dataset.mjs 已是输出形状，只做校验与裁剪） */
function buildImportedEntry(e) {
  const muscles = validateMuscles(e.name, e.category, e.muscles)
  if (!e.tips?.trim()) throw new Error(`导入动作「${e.name}」缺动作要点`)
  return { ...e, muscles, tips: e.tips.trim(), steps: validateSteps(e.name, e.steps) }
}

/** 动作要领：字符串数组，最多 12 条、单条 200 字（与 Rust / mock 的清洗口径一致） */
function validateSteps(name, steps) {
  if (steps == null) return []
  if (!Array.isArray(steps)) throw new Error(`动作「${name}」的 steps 必须是字符串数组`)
  const out = []
  for (const s of steps) {
    if (typeof s !== 'string') throw new Error(`动作「${name}」的 steps 含非字符串项`)
    const t = s.trim()
    if (t) out.push(t.slice(0, 200))
  }
  return out.slice(0, 12)
}

function main() {
  const plans = loadPlanMovements()
  const entries = [
    ...SPEC.map((s) => buildEntry(s, plans)),
    ...DATASET_EXERCISES.map(buildImportedEntry),
  ]

  const ids = new Set()
  const names = new Set()
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`重复的动作 id：${e.id}`)
    if (names.has(e.name)) throw new Error(`重复的动作名：${e.name}`)
    ids.add(e.id)
    names.add(e.name)
  }
  // 覆盖性校验：课程种子里的每个动作都必须能在动作库命中
  const missing = [...plans.keys()].filter((n) => !names.has(n))
  if (missing.length) throw new Error(`课程种子里的动作没有进库：${missing.join('、')}`)

  // 未使用的肌群键只提示不报错（新增键可以先只进模型，等有动作用到再标）
  const used = new Set(entries.flatMap((e) => Object.keys(e.muscles)))
  const unused = MUSCLE_KEYS.filter((k) => !used.has(k))
  if (unused.length) console.warn(`提示：以下肌群键暂无内置动作使用：${unused.join('、')}`)

  // 表单芯片分组必须覆盖全部键（漏掉 = 用户永远标不了那个肌群）
  const grouped = new Set(MUSCLE_GROUPS.flatMap((g) => g.keys))
  const ungrouped = MUSCLE_KEYS.filter((k) => !grouped.has(k))
  if (ungrouped.length) throw new Error(`MUSCLE_GROUPS 漏了这些键：${ungrouped.join('、')}`)

  const out = { version: 1, muscleKeys: MUSCLE_KEYS, exercises: entries }
  const file = path.join(root, 'resources', 'exercises.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(
    `已写入 ${path.relative(root, file)}：${entries.length} 个动作（覆盖课程种子 ${plans.size} 个动作，肌群键 ${MUSCLE_KEYS.length} 个）`,
  )
}

main()

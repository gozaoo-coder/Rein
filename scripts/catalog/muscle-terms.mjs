/**
 * exercises-dataset 英文肌群词 → Rein 肌群键的映射表。
 *
 * 背景：数据集只给 `target`（单个主肌）+ `muscle_group` + `secondary_muscles`，
 * 而且是**整块肌**粒度（glutes / quads / delts / traps / upper back），
 * 连上/下胸、三角肌三束都没有。所以：
 *   - 一个英文词往往对应多个 Rein 键（本表把它列全，宁多勿漏）；
 *   - 档位由词的角色决定：target → 3（主攻）、muscle_group → 2、secondary → 2；
 *   - **最终数据必须人工过审**（见 `resources/_review/dataset-review.json`），
 *     精选条目可以在 `dataset-selection.mjs` 里直接给出评审过的肌群表。
 */

/** 英文词（小写）→ Rein 肌群键（可多块） */
export const MUSCLE_TERMS = {
  // 胸
  pectorals: ['chest-low', 'chest-up'],
  chest: ['chest-low', 'chest-up'],
  'upper chest': ['chest-up'],
  // 肩
  deltoids: ['delt-ant', 'delt-lat', 'delt-post'],
  delts: ['delt-ant', 'delt-lat', 'delt-post'],
  shoulders: ['delt-ant', 'delt-lat', 'delt-post'],
  'rear deltoids': ['delt-post'],
  'rotator cuff': ['rotator-cuff'],
  // 背
  'latissimus dorsi': ['lats'],
  lats: ['lats'],
  'upper back': ['lats', 'rhomboids', 'traps-mid', 'teres-major'],
  back: ['lats', 'traps-mid', 'rhomboids'],
  rhomboids: ['rhomboids'],
  'lower back': ['lower-back'],
  spine: ['lower-back'],
  trapezius: ['traps-up', 'traps-mid', 'traps-low'],
  traps: ['traps-up', 'traps-mid', 'traps-low'],
  'levator scapulae': ['levator-scapulae'],
  'serratus anterior': ['serratus-ant'],
  // 手臂
  biceps: ['biceps'],
  brachialis: ['biceps'],
  triceps: ['triceps'],
  forearms: ['forearm'],
  wrists: ['forearm'],
  'wrist flexors': ['forearm'],
  'wrist extensors': ['forearm'],
  hands: ['forearm'],
  'grip muscles': ['forearm'],
  // 核心
  abs: ['abs'],
  abdominals: ['abs'],
  'lower abs': ['abs'],
  obliques: ['obliques'],
  core: ['abs', 'obliques'],
  'hip flexors': ['iliopsoas'],
  // 髋臀
  glutes: ['glute-max', 'glute-med'],
  abductors: ['glute-med', 'glute-min'],
  adductors: ['adductors'],
  'inner thighs': ['adductors'],
  groin: ['adductors'],
  // 腿
  quadriceps: ['quads-rec', 'quads-lat', 'quads-med', 'vastus-intermedius'],
  quads: ['quads-rec', 'quads-lat', 'quads-med', 'vastus-intermedius'],
  hamstrings: ['hamstrings'],
  calves: ['calves'],
  soleus: ['soleus'],
  shins: ['tibialis', 'tibialis-post'],
  ankles: ['tibialis', 'tibialis-post', 'fibularis'],
  'ankle stabilizers': ['tibialis-post', 'fibularis'],
  feet: ['tibialis', 'fibularis'],
  // 颈 / 其它
  sternocleidomastoid: ['scm'],
  'cardiovascular system': [],
}

/** 把一个英文肌群词翻成键数组（未知词返回空数组，交给人工审核表处理） */
export function keysForTerm(term) {
  if (!term) return []
  return MUSCLE_TERMS[String(term).trim().toLowerCase()] ?? []
}

/**
 * 按角色推导一份草稿肌群表：target → 3、muscle_group → 2、secondary → 2。
 * 同键取最高档；只用于生成评审草稿，正式数据以精选表/人工审核为准。
 */
export function draftActivation(entry) {
  const draft = {}
  const put = (term, level) => {
    for (const key of keysForTerm(term)) {
      draft[key] = Math.max(draft[key] ?? 0, level)
    }
  }
  put(entry.target, 3)
  put(entry.muscle_group, 2)
  for (const term of entry.secondary_muscles ?? []) put(term, 2)
  return draft
}

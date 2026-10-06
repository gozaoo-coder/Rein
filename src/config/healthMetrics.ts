/**
 * 健康体征指标与权限分组的展示配置。
 *
 * metric id / 分组 key 是**三方同名契约**的一端：
 *   Kotlin 桥 `HealthConnectBridge.readMetrics` 产出 → Rust `health_metrics` 表原样落库
 *   → 这里把它们翻译成中文标签与单位。改一处就得改三处。
 */

/** 权限分组：与 Kotlin 桥的 `CATEGORY_*` / `requestPermissions(mode)` 一一对应 */
export type HealthCategoryKey = 'exercise' | 'activity' | 'body' | 'vitals'

export interface HealthCategoryMeta {
  key: HealthCategoryKey
  label: string
  /** 授权引导里「这一组是干嘛的、Rein 拿它做什么」 */
  desc: string
}

export const HEALTH_CATEGORIES: HealthCategoryMeta[] = [
  {
    key: 'exercise',
    label: '运动',
    desc: '运动记录、消耗、距离、心率 —— 导入运动课并反推强度',
  },
  {
    key: 'activity',
    label: '活动与睡眠',
    desc: '每日步数、睡眠时长与深睡 / REM —— 活动量与休息恢复',
  },
  {
    key: 'body',
    label: '身体成分',
    desc: '体重、体脂、身高、基础代谢 —— 用真实测量替代手填档案',
  },
  {
    key: 'vitals',
    label: '身体机能',
    desc: '静息心率、HRV、血氧、呼吸率、体温、最大摄氧量、血压 —— 心肺与恢复状态',
  },
]

export interface HealthMetricMeta {
  key: string
  label: string
  /** 单位后缀；时长类留空（走 format 展示） */
  unit: string
  category: HealthCategoryKey
  /** 数值展示保留的小数位 */
  decimals: number
  /** `duration` = 分钟数折成「X小时Y分」展示 */
  format?: 'duration'
}

/** 展示顺序即页面内分组内的排列顺序 */
export const HEALTH_METRICS: HealthMetricMeta[] = [
  // 活动与睡眠
  { key: 'steps', label: '步数', unit: '步', category: 'activity', decimals: 0 },
  { key: 'sleep_min', label: '睡眠时长', unit: '', category: 'activity', decimals: 0, format: 'duration' },
  { key: 'sleep_deep_min', label: '深睡', unit: '', category: 'activity', decimals: 0, format: 'duration' },
  { key: 'sleep_rem_min', label: 'REM 睡眠', unit: '', category: 'activity', decimals: 0, format: 'duration' },
  // 身体成分
  { key: 'weight_kg', label: '体重', unit: 'kg', category: 'body', decimals: 1 },
  { key: 'body_fat_pct', label: '体脂率', unit: '%', category: 'body', decimals: 1 },
  { key: 'height_cm', label: '身高', unit: 'cm', category: 'body', decimals: 1 },
  { key: 'bmr_kcal', label: '基础代谢', unit: '千卡/日', category: 'body', decimals: 0 },
  // 身体机能
  { key: 'resting_hr_bpm', label: '静息心率', unit: '次/分', category: 'vitals', decimals: 0 },
  { key: 'hrv_rmssd_ms', label: '心率变异性', unit: 'ms', category: 'vitals', decimals: 0 },
  { key: 'spo2_pct', label: '血氧饱和度', unit: '%', category: 'vitals', decimals: 1 },
  { key: 'resp_rate_bpm', label: '呼吸率', unit: '次/分', category: 'vitals', decimals: 1 },
  { key: 'temp_c', label: '体温', unit: '°C', category: 'vitals', decimals: 1 },
  { key: 'vo2max_ml_kg_min', label: '最大摄氧量', unit: 'ml/kg/分', category: 'vitals', decimals: 1 },
  { key: 'bp_sys_mmhg', label: '收缩压', unit: 'mmHg', category: 'vitals', decimals: 0 },
  { key: 'bp_dia_mmhg', label: '舒张压', unit: 'mmHg', category: 'vitals', decimals: 0 },
]

export const HEALTH_METRIC_BY_KEY: Record<string, HealthMetricMeta> = Object.fromEntries(
  HEALTH_METRICS.map((m) => [m.key, m]),
)

/** 数值展示：时长折成「X小时Y分」，其余按 decimals 定点 */
export function formatMetricValue(meta: HealthMetricMeta, value: number): string {
  if (meta.format === 'duration') {
    const h = Math.floor(value / 60)
    const m = Math.round(value % 60)
    return h > 0 ? `${h}小时${m}分` : `${m}分钟`
  }
  return value.toFixed(meta.decimals)
}

/** 最近 n 天（含今天）的本地日期串，旧 → 新 */
export function lastLocalDays(n: number): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    out.push(
      `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
    )
  }
  return out
}

/** ISO 日期串 → 「N月N日」（预览卡与详情抽屉共用） */
export function formatMetricDay(day: string): string {
  const [, m, d] = day.split('-')
  return `${Number(m)}月${Number(d)}日`
}

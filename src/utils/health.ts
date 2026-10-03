/**
 * 身体数据的通用换算。目前只有 BMI；后续体脂率、腰高比等身体测量口径放这里，
 * 不散落在组件里 —— 档位标准一旦出现第二个调用方，两份分类就是两套真话。
 */

export type BmiTone = 'muted' | 'ok' | 'warn' | 'danger'

/** BMI = 体重 / 身高²；入参不完整（0/未录）返回 null，由调用方决定展示什么 */
export function bmiOf(weightKg: number | null, heightCm: number | null): number | null {
  if (!weightKg || !heightCm || heightCm < 50) return null
  const h = heightCm / 100
  return weightKg / (h * h)
}

/**
 * 中国成人 BMI 分档（WS/T 428-2013）：偏瘦 <18.5 / 正常 <24 / 偏胖 <28 / 肥胖 ≥28。
 * 不用 WHO 25/30 阈值 —— 方案引擎的食谱与人群口径都是国内标准。
 * muted（偏瘦）不给警示色：它更像「信息不足」而非「健康风险」。
 */
export function bmiBand(bmi: number): { label: string; tone: BmiTone } {
  if (bmi < 18.5) return { label: '偏瘦', tone: 'muted' }
  if (bmi < 24) return { label: '正常', tone: 'ok' }
  if (bmi < 28) return { label: '偏胖', tone: 'warn' }
  return { label: '肥胖', tone: 'danger' }
}

/**
 * 肌群标注的公共 JSON Schema：课程条目（upsert_plan）与动作库
 * （upsert_exercise / set_exercise_muscles）共用同一份键表与档位说明，
 * 保证模型在任何入口看到的键都是一致的 39 个。
 */

import { Type, type TSchema } from '@earendil-works/pi-ai'

import { MUSCLE_KEYS, MUSCLE_LABELS } from '@/config/muscles'

export const MUSCLE_LEVEL = Type.Union(
  [Type.Literal(1), Type.Literal(2), Type.Literal(3)],
  { description: '档位：1=稳定 2=辅助 3=主攻' },
)

/** 动作显式肌群：键为全部合法肌群键，值 1~3 档，只给练到的键 */
export const MUSCLES = Type.Object(
  Object.fromEntries(MUSCLE_KEYS.map((k) => [k, Type.Optional(MUSCLE_LEVEL)])) as Record<
    string,
    TSchema
  >,
  {
    description: [
      '动作训练到的肌群与档位（可选）。键与中文对照：',
      MUSCLE_KEYS.map((k) => `${k}=${MUSCLE_LABELS[k]}`).join(' / '),
      '。标注规则：3=主攻（真正的主要发力肌，通常不超过 3 个）、2=辅助（明显参与）、1=稳定（保持姿态，不发力也谈不上负荷）；',
      '只标动作真正练到的肌群，宁缺毋滥；填之前先调 list_exercises 看库内同名动作的肌群表，与其保持一致。',
      '不填则按动作名自动识别（卧推/深蹲/划船等常见名可识别），无法识别时该动作不显示肌群图。',
    ].join(''),
  },
)

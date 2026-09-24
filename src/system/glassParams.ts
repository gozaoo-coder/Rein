import { computed, ref } from 'vue'

/**
 * 液态玻璃（GlassSurface）的可调参数 —— system 层的界面级偏好。
 *
 * 为什么要可调：这套折射管线的默认值是**按 54~58px 的 UI 尺寸标定**出来的
 * （见 GlassSurface 头注释），换一块尺寸 / 换一种底色，合适的「厚度」「位移量」
 * 就会变。与其每次改代码重编，不如把管线上的 11 个数字摊开：画质预览页的
 * 「液态玻璃参数调节」面板就地改，改完存本地（`rein.glass.v1`），GlassSurface
 * 的默认值读这里 —— 组件调用处仍然只给尺寸与圆角，材质只有这一份定义。
 *
 * 只有**折射分支**读这些值（普通毛玻璃档走 CSS 令牌 --glass-fill / blur）；
 * 所以调参时要把档位切到「超高」才看得见差别。
 *
 * 英文键名与 GlassSurface 的 prop 同名（面板里并列显示中文名），
 * 定稿后把选定的数写回 GLASS_DEFAULTS 即可 —— 面板的「恢复默认」就是回到它。
 */
export type GlassParamKey =
  | 'borderWidth'
  | 'brightness'
  | 'opacity'
  | 'blur'
  | 'distortionScale'
  | 'redOffset'
  | 'greenOffset'
  | 'blueOffset'
  | 'displace'
  | 'saturation'
  | 'backgroundOpacity'

export interface GlassParamSpec {
  key: GlassParamKey
  /** 中文名（与英文键名并列显示） */
  cn: string
  min: number
  max: number
  step: number
}

/**
 * 参数清单（也是面板的渲染顺序）：按管线的数据流排 ——
 * 位移贴图（边缘厚度 / 中心亮度 / 贴图不透明度 / 贴图模糊）→ 三通道位移
 * （位移强度 / 三个通道偏移）→ 收尾（边缘柔化）→ 表面（背景饱和度 / 底色浓度）。
 * 区间刻意给宽（面板是给「调到合适为止」用的，不是给日常微调的）。
 */
export const GLASS_PARAM_SPECS: GlassParamSpec[] = [
  { key: 'borderWidth', cn: '边缘厚度', min: 0, max: 1, step: 0.02 },
  { key: 'brightness', cn: '中心亮度', min: 0, max: 100, step: 1 },
  { key: 'opacity', cn: '贴图不透明度', min: 0, max: 1, step: 0.05 },
  { key: 'blur', cn: '贴图模糊', min: 0, max: 100, step: 1 },
  { key: 'distortionScale', cn: '折射位移强度', min: -100, max: 100, step: 1 },
  { key: 'redOffset', cn: '红通道偏移', min: -60, max: 60, step: 1 },
  { key: 'greenOffset', cn: '绿通道偏移', min: -60, max: 60, step: 1 },
  { key: 'blueOffset', cn: '蓝通道偏移', min: -60, max: 60, step: 1 },
  { key: 'displace', cn: '边缘柔化', min: 0, max: 8, step: 0.1 },
  { key: 'saturation', cn: '背景饱和度', min: 0, max: 5, step: 0.1 },
  { key: 'backgroundOpacity', cn: '玻璃底色浓度', min: 0, max: 1, step: 0.02 },
]

/**
 * 默认值 = 2026-09-24 在画质预览页的调节面板上定稿的一组（对着 54~58px 的 UI 尺寸
 * 调出来的）。标定要点：亮度略高于中灰，让位移贴图的中心几乎不位移、只有边缘在折射；
 * 边缘厚度 0.28 + 位移强度 -31 让边缘带与位移量同量级（糊不成彩色条纹）；
 * 底色浓度 0.46 与高画质档的 --glass-fill 同量级 —— 页签文字的真图对比度守得住
 * （scripts/e2e-perf-glass.mjs 第 6 节）。
 */
export const GLASS_DEFAULTS: Record<GlassParamKey, number> = {
  borderWidth: 0.28,
  brightness: 56,
  opacity: 1,
  blur: 34,
  distortionScale: -31,
  redOffset: 0,
  greenOffset: 0,
  blueOffset: 0,
  displace: 1.3,
  saturation: 1.4,
  backgroundOpacity: 0.46,
}

const STORE_KEY = 'rein.glass.v1'

function clamp(spec: GlassParamSpec, value: number): number {
  return Math.min(spec.max, Math.max(spec.min, value))
}

/** 读本地参数：缺项 / 损坏 / 越界一律回落默认值（面板拖坏了也不能拖垮玻璃） */
function load(): Record<GlassParamKey, number> {
  const out = { ...GLASS_DEFAULTS }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return out
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return out
    for (const spec of GLASS_PARAM_SPECS) {
      const value = (parsed as Record<string, unknown>)[spec.key]
      if (typeof value === 'number' && Number.isFinite(value)) out[spec.key] = clamp(spec, value)
    }
  } catch {
    /* 本地存储不可用 → 默认值 */
  }
  return out
}

/** 当前生效的参数（GlassSurface 的默认值读它；面板改的也是它） */
export const glassParams = ref<Record<GlassParamKey, number>>(load())

/** 是否已经偏离出厂值（面板据此点亮「恢复默认」） */
export const glassTuned = computed(() =>
  GLASS_PARAM_SPECS.some((spec) => glassParams.value[spec.key] !== GLASS_DEFAULTS[spec.key]),
)

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(glassParams.value))
  } catch {
    /* 存不下就只留内存态 */
  }
}

export function specOf(key: GlassParamKey): GlassParamSpec {
  return GLASS_PARAM_SPECS.find((spec) => spec.key === key)!
}

export function setGlassParam(key: GlassParamKey, value: number): void {
  if (!Number.isFinite(value)) return
  glassParams.value = { ...glassParams.value, [key]: clamp(specOf(key), value) }
  persist()
}

export function resetGlassParams(): void {
  glassParams.value = { ...GLASS_DEFAULTS }
  persist()
}

/**
 * useAnime — anime.js v4 集成中心
 *
 * 设计原则（与 tokens.css 的 MOTION 区块、useMotion.ts 的 spring 预设同步）：
 *   1. 以 anime.js v4 模块化 API 为底座：animate / createScope / createLayout /
 *      createDraggable / spring / stagger。tree-shaking 友好，按子路径导入。
 *   2. Spring 预设与 tokens.css 的 --spring-* 一一对应，数值与 useMotion.ts 的
 *      SPRINGS 保持一致，便于改一处生效。anime.js spring 使用 { stiffness, damping,
 *      mass, bounce } 物理参数，比 motion-v 多一个 bounce 维度（默认 0）。
 *   3. 所有动画通过 createScope 注册，onScopeDispose 自动 revert，杜绝泄漏。
 *   4. 尊重 prefers-reduced-motion：开启时降级为瞬时跳变。
 *   5. 预设是纯数据/工厂函数，零运行时成本；仅在被调用时才创建动画实例。
 *
 * 使用：
 *   import { useAnime } from '@/composables/useAnime'
 *   const rootRef = ref<HTMLElement | null>(null)
 *   const { scope, animate, springs, enter, staggerEnter } = useAnime(rootRef)
 *   // 在事件或 watch 中：
 *   enter(rootRef.value!, 'fadeUp')
 *   staggerEnter('.card-cell')
 */
import { onScopeDispose, ref, type Ref } from "vue";
import { animate as animeAnimate, createScope, type Scope } from "animejs";
import { spring as animeSpring, stagger as animeStagger, type Spring, utils } from "animejs";
import type { AnimationParams, EasingParam } from "animejs";

// ===== Spring 物理预设 =====
// 与 tokens.css 的 --spring-* 及 useMotion.ts 的 SPRINGS 一一对应。
// anime.js v4 spring 默认 stiffness=100, damping=10, mass=1, bounce=0。
// 这里复用 motion-v 的数值（stiffness 200~420, damping 24~34），手感一致。
export const SPRINGS = {
  /** 反馈型：tap、indicator 滑动 —— 轻微 overshoot */
  snappy: { stiffness: 420, damping: 28, mass: 1 },
  /** 平滑型：hover、layout 切换 —— 无 overshoot */
  smooth: { stiffness: 200, damping: 26, mass: 1 },
  /** Sheet 型：底部 sheet 拖拽回弹 —— 沉稳 */
  sheet: { stiffness: 320, damping: 34, mass: 1 },
  /** 卡片型：卡片入场、FLIP —— 微弹 */
  card: { stiffness: 260, damping: 24, mass: 1 },
} satisfies Record<string, { stiffness: number; damping: number; mass: number }>;

// ===== Tween 兜底（用于不能用 spring 的属性，如 opacity / SVG dash） =====
// 与 tokens.css 的 --dur-* / --ease-* 同步。anime.js ease 接受字符串或函数。
export const TWEENS = {
  fast: { duration: 300, ease: "inOutQuad" as EasingParam },
  page: { duration: 320, ease: "outExpo" as EasingParam },
  sheet: { duration: 420, ease: "outQuint" as EasingParam },
  toast: { duration: 240, ease: "outQuint" as EasingParam },
} satisfies Record<string, { duration: number; ease: EasingParam }>;

// ===== 入场/退场 Variant 预设 =====
// 设计：尊重 HarmonyOS 沉浸光感——不使用 iOS push；使用 fade+轻微 slide/scale。
// 每个变体返回 animate 的 parameters（不含 targets）。
export const VARIANTS = {
  /** 上淡入：列表项、卡片入场 */
  fadeUp: {
    initial: { opacity: 0, translateY: 12 },
    animate: { opacity: 1, translateY: 0 },
    exit: { opacity: 0, translateY: -8 },
  },
  /** 缩放淡入：弹窗、下拉、浮层 */
  scaleIn: {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.96 },
  },
  /** 底部 sheet：从底部滑入 */
  sheetUp: {
    initial: { opacity: 0, translateY: "100%" },
    animate: { opacity: 1, translateY: 0 },
    exit: { opacity: 0, translateY: "100%" },
  },
  /** 桌面弹窗：中心缩放 */
  popIn: {
    initial: { opacity: 0, scale: 0.92 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.92 },
  },
  /** 路由转场：右进左出，淡入 */
  pageRight: {
    initial: { opacity: 0, translateX: 24 },
    animate: { opacity: 1, translateX: 0 },
    exit: { opacity: 0, translateX: -24 },
  },
  /** 纯淡入：toast、遮罩 */
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
} satisfies Record<
  string,
  { initial: Record<string, number | string>; animate: Record<string, number | string>; exit: Record<string, number | string> }
>;

export type VariantName = keyof typeof VARIANTS;

// ===== Stagger 配置 =====
export const STAGGER = {
  /** 列表容器：子项 50ms 间隔，首项延迟 40ms */
  list: { interval: 50, start: 40 },
  /** 网格容器：子项 40ms 间隔，从中心扩散 */
  grid: { interval: 40, from: "center" as const },
};

/**
 * 检测用户是否偏好减弱动效。响应式 ref，匹配媒体查询变化自动更新。
 */
export function useReducedMotion(): Ref<boolean> {
  const reduced = ref(false);
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.value = mq.matches;
    const handler = (e: MediaQueryListEvent) => (reduced.value = e.matches);
    mq.addEventListener?.("change", handler);
    onScopeDispose(() => mq.removeEventListener?.("change", handler));
  }
  return reduced;
}

/**
 * 工厂 hook：返回 anime.js v4 集成工具集。
 *
 * @param rootRef 可选的根元素 ref；传入后 createScope 以其为 root，所有动画
 *   在该 scope 内创建，组件卸载时自动 revert。不传则使用 document。
 *
 * 返回：
 *   - scope: anime.js Scope 实例（可执行 scope.add / scope.methods）
 *   - animate: animate 包装，自动注册到 scope
 *   - spring: spring 工厂，传入预设名生成 EasingParam
 *   - stagger: stagger 工厂
 *   - enter / exit: 入场/退场快捷方法
 *   - staggerEnter: 列表/网格 stagger 入场
 *   - springs / tweens / variants / staggerCfg: 预设常量
 *   - reduced: 是否降级动效
 */
export function useAnime(rootRef?: Ref<HTMLElement | null>) {
  const reduced = useReducedMotion();

  const scope = createScope({
    root: rootRef?.value ?? undefined,
    mediaQueries: {
      reduce: "(prefers-reduced-motion: reduce)",
    },
  });

  // 组件卸载时自动清理所有动画/draggable/layout
  onScopeDispose(() => scope.revert());

  /** spring 预设工厂：传入预设名返回 EasingParam */
  function spring(name: keyof typeof SPRINGS = "smooth"): Spring {
    return animeSpring(SPRINGS[name]);
  }

  /** stagger 工厂：传入预设名返回 stagger 函数 */
  function stagger(name: keyof typeof STAGGER = "list") {
    const cfg = STAGGER[name];
    return animeStagger(cfg.interval, {
      start: cfg.start ?? 0,
      from: cfg.from,
    });
  }

  /**
   * animate 包装：自动注册到 scope，尊重 reduced-motion。
   * reduced 时直接 set 目标值，跳过动画。
   */
  function animate(
    targets: Parameters<typeof animeAnimate>[0],
    params: AnimationParams,
  ) {
    if (reduced.value) {
      // 降级：把 to 值直接 set 到目标，duration=1
      const { duration, ...rest } = params;
      return scope.add(() =>
        animeAnimate(targets, { ...rest, duration: 1 }),
      ) as unknown as ReturnType<typeof animeAnimate>;
    }
    let inst: ReturnType<typeof animeAnimate> | null = null;
    scope.add(() => {
      inst = animeAnimate(targets, params);
    });
    return inst!;
  }

  /**
   * 入场动画快捷方法。
   * @param targets 目标
   * @param variant 变体名，默认 fadeUp
   * @param opts 额外参数（delay、stagger、spring 名等）
   */
  function enter(
    targets: Parameters<typeof animeAnimate>[0],
    variant: VariantName = "fadeUp",
    opts: {
      delay?: number | ReturnType<typeof animeStagger>;
      springName?: keyof typeof SPRINGS;
      duration?: number;
    } = {},
  ) {
    const v = VARIANTS[variant];
    const params: AnimationParams = {
      ...v.initial,
      ...v.animate,
      ease: opts.springName ? spring(opts.springName) : spring("card"),
      delay: opts.delay,
      duration: opts.duration,
      autoplay: true,
    };
    return animate(targets, params);
  }

  /**
   * 退场动画快捷方法。返回 Promise，便于 await 后移除 DOM。
   */
  function exit(
    targets: Parameters<typeof animeAnimate>[0],
    variant: VariantName = "fadeUp",
    opts: {
      delay?: number | ReturnType<typeof animeStagger>;
      springName?: keyof typeof SPRINGS;
      duration?: number;
    } = {},
  ) {
    const v = VARIANTS[variant];
    const params: AnimationParams = {
      ...v.exit,
      ease: opts.springName ? spring(opts.springName) : spring("smooth"),
      delay: opts.delay,
      duration: opts.duration,
      autoplay: true,
    };
    return animate(targets, params).then?.(() => undefined) ?? Promise.resolve();
  }

  /**
   * 列表/网格 stagger 入场。
   * @param targets 目标选择器或元素
   * @param variant 子项变体名
   * @param staggerName stagger 预设名（list / grid）
   */
  function staggerEnter(
    targets: Parameters<typeof animeAnimate>[0],
    variant: VariantName = "fadeUp",
    staggerName: keyof typeof STAGGER = "list",
  ) {
    return enter(targets, variant, { delay: stagger(staggerName) });
  }

  return {
    scope,
    reduced,
    animate,
    enter,
    exit,
    staggerEnter,
    spring,
    stagger,
    springs: SPRINGS,
    tweens: TWEENS,
    variants: VARIANTS,
    staggerCfg: STAGGER,
    utils,
  };
}

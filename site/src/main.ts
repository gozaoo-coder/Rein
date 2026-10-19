import './styles/site.css'
import { animate, inView } from 'motion'

const root = document.documentElement
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// 缓动与时长一律从真源令牌里读，不在 JS 里另写一条贝塞尔（DESIGN-BRIEF §4）。
function cssValue(name: string): string {
  return getComputedStyle(root).getPropertyValue(name).trim()
}

type Bezier = [number, number, number, number]

function tokenEase(name: string, fallback: Bezier): Bezier {
  const match = cssValue(name).match(/cubic-bezier\(([^)]+)\)/)
  if (!match) return fallback
  const points = match[1].split(',').map((part) => Number.parseFloat(part))
  return points.length === 4 ? (points as Bezier) : fallback
}

function tokenMs(name: string, fallback: number): number {
  const match = cssValue(name).match(/([\d.]+)ms/)
  return match ? Number.parseFloat(match[1]) : fallback
}

const easeOut = tokenEase('--ease-out', [0.33, 1, 0.68, 1])
const easeStandard = tokenEase('--ease-standard', [0.25, 0.1, 0.25, 1])
const durBase = tokenMs('--dur-base', 250) / 1000
const durSlow = tokenMs('--dur-slow', 480) / 1000

// 1) 版本号：构建时从仓库根 package.json 的 version 注入。
const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
document.querySelectorAll<HTMLElement>('[data-version]').forEach((el) => {
  el.textContent = version ? `v${version}` : ''
})

// 2) 玻璃顶栏：滚起来之后受光边与内顶高光出现。
const nav = document.querySelector<HTMLElement>('.nav')
if (nav) {
  const syncGlass = () => {
    nav.classList.toggle('is-scrolled', window.scrollY > 8)
  }
  syncGlass()
  window.addEventListener('scroll', syncGlass, { passive: true })
}

// 3) 滚动显形：元素进视口时位移 + 淡入，只跑一次。
const reveals = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
if (reduceMotion) {
  reveals.forEach((el) => {
    el.style.opacity = '1'
    el.style.transform = 'none'
  })
} else {
  reveals.forEach((el) => {
    const delay = Number(el.dataset.revealDelay ?? 0) / 1000
    let stop: () => void = () => {}
    stop = inView(
      el,
      () => {
        animate(
          el,
          { opacity: [0, 1], y: [26, 0] },
          { duration: durSlow, delay, ease: easeOut },
        )
        stop()
      },
      { amount: 0.2 },
    )
  })
}

// 4) 数字滚动：读数从 0 爬到目标值，曲线同样取令牌。
document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
  const target = Number(el.dataset.count ?? 0)
  if (!Number.isFinite(target)) return
  if (reduceMotion) {
    el.textContent = String(target)
    return
  }
  let stop: () => void = () => {}
  stop = inView(
    el,
    () => {
      animate(0, target, {
        duration: durSlow * 1.4,
        ease: easeOut,
        onUpdate: (value) => {
          el.textContent = String(Math.round(value))
        },
      })
      stop()
    },
    { amount: 0.6 },
  )
})

// 5) 顶栏当前分区高亮。
const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.nav-links a[href^="#"]'))
const sections = navLinks
  .map((link) => document.querySelector<HTMLElement>(link.getAttribute('href') ?? ''))
  .filter((section): section is HTMLElement => section !== null)

if (sections.length > 0 && 'IntersectionObserver' in window) {
  const setCurrent = (id: string) => {
    navLinks.forEach((link) => {
      const on = link.getAttribute('href') === `#${id}`
      link.classList.toggle('is-current', on)
      if (on) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
    })
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (visible) setCurrent(visible.target.id)
    },
    { rootMargin: `-${72}px 0px -55% 0px`, threshold: [0.1, 0.4, 0.7] },
  )
  sections.forEach((section) => observer.observe(section))

  // 微交互：指针下的卡片轻微跟手抬起（指针精度设备才开）。
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches && !reduceMotion) {
    document.querySelectorAll<HTMLElement>('[data-tilt]').forEach((card) => {
      card.addEventListener('pointermove', (event) => {
        const rect = card.getBoundingClientRect()
        const dx = (event.clientX - rect.left) / rect.width - 0.5
        const dy = (event.clientY - rect.top) / rect.height - 0.5
        animate(card, { rotateX: -dy * 4, rotateY: dx * 4 }, { duration: durBase, ease: easeStandard })
      })
      card.addEventListener('pointerleave', () => {
        animate(card, { rotateX: 0, rotateY: 0 }, { duration: durBase, ease: easeOut })
      })
    })
  }
}

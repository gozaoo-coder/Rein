/**
 * 无头浏览器启动器。
 *
 * playwright-core 不带浏览器，所以要自己找 executablePath。优先级：
 *   1. Playwright 缓存里的 chromium（%LOCALAPPDATA%/ms-playwright/chromium-*）
 *   2. 系统 Edge（几乎每台机器都有）
 *   3. 系统 Chrome
 * 录制要保持一致的三件事：dpr=1、禁滚动条、强制 sRGB 色彩配置。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const LOCAL = process.env.LOCALAPPDATA ?? ''

export function resolveChromium() {
  const cache = join(LOCAL, 'ms-playwright')
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of dirs) {
      for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome']) {
        const p = join(cache, d, rel)
        if (existsSync(p)) return { kind: 'exe', path: p }
      }
    }
  }
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  if (existsSync(edge)) return { kind: 'exe', path: edge }
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  if (existsSync(chrome)) return { kind: 'exe', path: chrome }
  throw new Error('找不到可用的 Chromium：Playwright 缓存 / Edge / Chrome 都没有')
}

const ARGS = [
  '--force-device-scale-factor=1',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--run-all-compositor-stages-before-draw',
]

export async function launch({ width = 1920, height = 1080, scale = 1 } = {}) {
  const found = resolveChromium()
  const browser = await chromium.launch({
    executablePath: found.path,
    headless: true,
    args: ARGS,
  })
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  })
  const page = await context.newPage()
  return { browser, context, page, chromium: found }
}

/** 等页面把 __promo 挂上，并确保字体与首屏都就绪。 */
export async function waitReady(page, timeout = 30000) {
  await page.waitForFunction(() => globalThis.__promo?.ready === true, null, { timeout })
  await page.evaluate(() => document.fonts?.ready)
  await page.evaluate(
    () =>
      new Promise((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r(true)))
      }),
  )
}

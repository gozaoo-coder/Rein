/**
 * 桂电教务会话的共用实现（工具代码，不属于 App）。
 *
 * 抽出来的理由：登录握手 / Cookie 管理 / SSO 选课令牌 / 信封约定四件事，
 * `probe-course-select.mjs` 与 `course-watch.mjs` 都要用。抄第二份必然漂 ——
 * 而漂掉的后果是「探查脚本好好的，监控脚本登录不上」这种最难查的故障。
 *
 * 三条纪律，与 Rust 侧 `modules/campus/*` 保持一致：
 * 1. 公钥从 `provider.rs` 正则读，**不在这里抄一份**（抄错一个字符就是
 *    「digital envelope routines::decode error」，且很难一眼看出）。
 * 2. 密码只在内存里过一遍，**不打印、不落盘**。
 * 3. 选课接口的信封是反的：`result` 为真表示**出错**（成功是 `result: 0`）。
 *    整个项目只有这里相反，所以判断只写在 `api()` 一处。
 */
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 浏览器伪装头。与 Rust `http.rs` 的 USER_AGENT 同一串，避免被风控当成脚本。 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 选课 API 前缀。路径与 Rust `course_select.rs` 的 API 常量一致。 */
export const API = '/course-selection-api/api/v1/student/course-select'

/** 令牌失效时 Rust 侧用的同一句话，便于两边日志对得上。 */
export const TOKEN_EXPIRED = '选课令牌已失效'

export const DEFAULT_BASE = 'https://bkjwtest.guet.edu.cn'

/** 本地 App 数据库。账号是唯一事实来源，工具只读。 */
export function defaultDbPath() {
  return path.join(process.env.APPDATA ?? '', 'com.gozaoo.rein', 'rein.db')
}

/* ─────────────────────────── 登录公钥 ─────────────────────────── */

export function publicKeyB64() {
  const src = fs.readFileSync(
    path.join(HERE, '..', '..', 'src-tauri', 'src', 'modules', 'campus', 'provider.rs'),
    'utf8',
  )
  const m = /public_key:\s*"([A-Za-z0-9+/=]+)"/.exec(src)
  if (!m) throw new Error('provider.rs 里没找到登录公钥')
  return m[1]
}

/** RSA_PKCS1_v1_5(salt + '-' + password)，与登录页 JSEncrypt 等价。 */
export function rsaEncrypt(salt, password) {
  const der = Buffer.from(publicKeyB64(), 'base64')
  const pem =
    '-----BEGIN PUBLIC KEY-----\n' +
    der.toString('base64').replace(/(.{64})/g, '$1\n').trim() +
    '\n-----END PUBLIC KEY-----\n'
  return crypto
    .publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(`${salt}-${password}`, 'utf8'),
    )
    .toString('base64')
}

/* ─────────────────────────── 会话 ─────────────────────────── */

export class GuetSession {
  constructor(base = DEFAULT_BASE) {
    this.base = String(base).trim().replace(/\/+$/, '')
    /** 手动管 Cookie —— 与 Rust `http.rs` 的 CookieJar 同策略（不跟随重定向、自己收 Set-Cookie）。 */
    this.jar = new Map()
    this.token = null
    this.tokenExp = 0
  }

  get cookieNames() {
    return [...this.jar.keys()]
  }

  cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 会话是否还在（与 Rust `CookieJar::has_session_ticket` 同一判据）。 */
  hasTicket() {
    return this.jar.has('__pstsid__') || this.jar.has('SESSION')
  }

  absorb(res) {
    const list = res.headers.getSetCookie?.() ?? []
    for (const raw of list) {
      const [pair] = raw.split(';')
      const i = pair.indexOf('=')
      if (i < 0) continue
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      if (!value || value === 'deleteMe') this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }

  /**
   * 一次原始请求。**不跟随重定向** —— 302 是教务说「会话过期了」的方式，
   * 跟过去只会被静默跳到登录页拿到 200，把过期伪装成成功。
   */
  async req(method, p, { body, headers = {}, timeoutMs = 20000, referer } = {}) {
    const url = p.startsWith('http') ? p : this.base + p
    const c = new AbortController()
    const timer = setTimeout(() => c.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        signal: c.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: this.base,
          ...(referer ? { Referer: this.base + referer } : {}),
          ...(this.jar.size ? { Cookie: this.cookieHeader() } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      })
      this.absorb(res)
      const text = await res.text()
      return { status: res.status, text, headers: res.headers }
    } finally {
      clearTimeout(timer)
    }
  }

  async reqJson(method, p, opts) {
    const r = await this.req(method, p, opts)
    let json = null
    try {
      json = JSON.parse(r.text)
    } catch {
      /* 非 JSON 留着原文给调用方看 */
    }
    return { ...r, json }
  }

  /* ---------------- 登录握手 ---------------- */

  /**
   * 用 App 落库的 Cookie 恢复会话（`campus_accounts.cookies`，形状 `[{name,value}]`）。
   *
   * 比密码优先试它的理由很实际：**密码可能已经改了而库里还是旧的**，
   * 但那份 EAMS 会话往往还有效 —— 能用就不该逼用户去重登。
   */
  primeJar(cookies) {
    let list = cookies
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list)
      } catch {
        return false
      }
    }
    // 库里存的是 Rust `CookieJar { items: Vec<(String,String)> }` 的序列化形状：
    // `{"items":[["__pstsid__","…"],["SESSION","…"]]}` —— **成对数组**，不是 {name,value} 对象。
    // 只认裸数组时这一步永远返回 false，于是每次心跳都退回密码登录：
    // 一天一百多次登录，正是风控最容易被点亮的东西（2026-09-21 实测确认这条路径从未生效）。
    if (list && !Array.isArray(list) && Array.isArray(list.items)) list = list.items
    if (!Array.isArray(list) || !list.length) return false
    for (const c of list) {
      const name = (Array.isArray(c) ? c[0] : c?.name)?.trim?.()
      const value = (Array.isArray(c) ? c[1] : c?.value)?.trim?.()
      if (name && value) this.jar.set(name, value)
    }
    return this.jar.size > 0
  }

  /**
   * EAMS 门户登录。成功返回 `{ ok: true }`；失败把教务的原话带回来
   * （`needCaptcha` / `weak_password` 这类要用户去处理的，不能吞掉）。
   *
   * **判定语义与选课接口相反：这里的 `result` 为真才是成功。**
   * 2026-09-21 实测的拒绝形状：`{"result":false,"message":"用户名或密码错误","needCaptcha":true}`
   * —— `result:false` 配上明说「密码错误」的 message，不可能是成功。
   *
   * 这里曾经把选课接口那套「result 为真是出错」照搬过来，后果不是记错一行日志：
   * **成功被当成失败丢掉**，于是监控脚本一天里 140 多次「本轮失败：登录失败：教务拒绝了
   * 这次登录（未给出原因，通常是密码已变更）」全是假警报，而真正失败的那几次反倒被当成
   * 成功继续往下跑。判定表与 Rust 侧 `guet.rs::login_failure` 对齐，两边只此一份口径。
   */
  async login(username, password, captcha = '') {
    const saltRes = await this.req('GET', '/student/ldap/login-salt')
    if (saltRes.status !== 200) {
      return { ok: false, message: `取登录盐失败：HTTP ${saltRes.status}`, needCaptcha: false }
    }
    const salt = saltRes.text.trim()
    const res = await this.reqJson('POST', '/student/ldap/login', {
      body: { username, password: rsaEncrypt(salt, password), captcha },
      referer: '/student/ldap/login',
      timeoutMs: 30000,
    })
    if (res.status !== 200 || res.json == null) {
      return { ok: false, message: `登录响应异常：HTTP ${res.status}`, needCaptcha: false }
    }
    const needCaptcha = res.json.needCaptcha === true
    if (res.json.result === true) return { ok: true, needCaptcha, message: String(res.json.message ?? '') }

    const raw = String(res.json.message ?? '').trim()
    // 教务拒绝时**未必给 message**，这种情况不许替它编一个原因 —— 编出来的「密码错误」
    // 会把「其实只是缺验证码」的线索带偏（Rust 侧同一张表）。
    const message =
      raw === 'weak_password'
        ? '密码强度不足，需先在教务改密'
        : raw === 'login_first'
          ? '教务要求先完成首次登录（去 App 里登录一次）'
          : raw
            ? raw
            : needCaptcha && !String(captcha).trim()
              ? '需要输入验证码'
              : needCaptcha
                ? '验证码不正确，请重新输入'
                : '登录被拒绝：请核对学号与密码（教务系统没有返回具体原因）'
    return { ok: false, message, needCaptcha, raw }
  }

  /** 会话是否还有效。302 = 过期（`redirect: manual` 才看得见）。 */
  async probe() {
    const r = await this.req('GET', '/student/home')
    return r.status === 200
  }

  /* ---------------- 选课令牌 ---------------- */

  /**
   * 去门户换 SSO 选课令牌。
   *
   * 令牌写死在 `/student/for-std/course-select` 页面里（`course-selection/?token=<JWT>`）。
   * 载荷 `{iss, exp, username}`，HS256 —— 我们只解 `exp` 用于缓存，不验签。
   */
  async acquireToken() {
    const entry = await this.req('GET', '/student/for-std/course-select', { timeoutMs: 30000 })
    if (entry.status === 302) return { ok: false, message: '教务会话已过期（302），需要重新登录' }
    const m = /course-selection\/\?token=([A-Za-z0-9._-]+)/.exec(entry.text)
    if (!m) {
      const hint = entry.text.slice(0, 200).replace(/\s+/g, ' ')
      return { ok: false, message: `没抓到选课令牌，页面片段：${hint}` }
    }
    this.token = m[1]
    this.tokenExp = jwtExp(this.token)
    return { ok: true, token: this.token, exp: this.tokenExp }
  }

  /** 令牌是否还够用（留 5 分钟余量 —— 抢课要连续轮询，卡在过期边界上很难查）。 */
  tokenFresh(marginSec = 300) {
    if (!this.token) return false
    if (!this.tokenExp) return true // 解不出 exp 就当作没期限，靠 401 兜底
    return this.tokenExp - Math.floor(Date.now() / 1000) > marginSec
  }

  /* ---------------- 选课 API ---------------- */

  /**
   * 选课 API 调用。信封反直觉：`result` 为真 = 出错。
   * 401 → 清掉令牌并抛出 `TOKEN_EXPIRED`，让调用方重换一张。
   */
  async api(p, { method = 'GET', body, timeoutMs = 20000 } = {}) {
    if (!this.token) throw new Error('还没有选课令牌，先 acquireToken()')
    const res = await this.reqJson(method, API + p, {
      body,
      timeoutMs,
      headers: { Authorization: this.token, Referer: this.base + '/course-selection/' },
    })
    if (res.status === 401) {
      this.token = null
      this.tokenExp = 0
      throw new Error(TOKEN_EXPIRED)
    }
    if (res.status === 302) throw new Error('教务会话已过期（302），需要重新登录')
    if (res.json == null) throw new Error(`选课接口返回非 JSON：HTTP ${res.status}`)
    if (res.json.result === true) {
      throw new Error(String(res.json.message ?? `选课接口报错：HTTP ${res.status}`))
    }
    return res.json.data
  }

  /** 令牌可能过期时自动重换一次 —— 抢课/监控都会长时间挂在上面。 */
  async withToken(fn) {
    if (!this.tokenFresh()) {
      const got = await this.acquireToken()
      if (!got.ok) throw new Error(got.message)
    }
    try {
      return await fn()
    } catch (e) {
      if (!String(e?.message ?? e).includes(TOKEN_EXPIRED)) throw e
      const got = await this.acquireToken()
      if (!got.ok) throw new Error(got.message)
      return await fn()
    }
  }

  /* ---------------- 具体接口 ---------------- */

  serverTime() {
    return this.withToken(() => this.api('/getCurrentDateTime'))
  }

  students() {
    return this.withToken(() => this.api('/multiple-students'))
  }

  openTurns(studentId) {
    return this.withToken(() => this.api(`/open-turns/${studentId}`))
  }

  turnSelect(studentId, turnId) {
    return this.withToken(() => this.api(`/${studentId}/turn/${turnId}/select`))
  }

  /**
   * 查教学班。**必须带 `hasCount: true`** —— 不勾选时教务可能不给 `stdCount`，
   * 而没有它就无法判断「满没满」（见 Rust `models.rs` 的 LessonQuery 注释）。
   */
  queryLessons(studentId, turnId, query = {}) {
    return this.withToken(() =>
      this.api(`/query-lesson/${studentId}/${turnId}`, {
        method: 'POST',
        body: { hasCount: true, sortField: 'lessonAssoc', sortType: 'ASC', ...query },
        timeoutMs: 60000,
      }),
    )
  }

  simplestLessons(turnId) {
    return this.withToken(() => this.api(`/simplest-lessons/${turnId}`, { timeoutMs: 60000 }))
  }

  selectedLessons(turnId, studentId) {
    return this.withToken(() => this.api(`/selected-lessons/${turnId}/${studentId}`))
  }
}

/** 解 JWT 载荷里的 `exp`（秒）。解不出返回 0。 */
export function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return Number(payload.exp) || 0
  } catch {
    return 0
  }
}

/**
 * 从本地 App 数据库读 active 账号。**只读**，且调用方不得打印返回值里的密码。
 */
export function readAccount(dbPath = defaultDbPath()) {
  if (!fs.existsSync(dbPath)) throw new Error(`找不到本地数据库：${dbPath}`)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db
      .prepare(
        'SELECT login_name, password, cookies, base_url, student_id, session_at ' +
          'FROM campus_accounts WHERE active = 1 ORDER BY updated_at DESC LIMIT 1',
      )
      .get()
    if (!row) throw new Error('本地库里没有已绑定的教务账号')
    return {
      user: row.login_name,
      pass: row.password ?? null,
      cookies: row.cookies ?? null,
      base: row.base_url || DEFAULT_BASE,
      studentId: row.student_id ?? null,
      sessionAt: row.session_at ?? null,
    }
  } finally {
    db.close()
  }
}

/**
 * 建一个可用的会话。顺序是**先救已有会话、再动密码**：
 *
 * 1. 用库里存的 Cookie 直接打 `/student/home`。有效就收工 —— 不必碰密码，
 *    也不会在教务那边多留一条登录记录。
 * 2. 无效才走密码登录。此时要求库里有密码，否则只能让用户去 App 里重登。
 *
 * 返回 `{ session, account, via }`，`via` 是 `'cookie'` 或 `'password'`，用于日志。
 */
export async function connect(account) {
  const acc = account ?? readAccount()
  const session = new GuetSession(acc.base)

  if (session.primeJar(acc.cookies) && (await session.probe())) {
    return { session, account: acc, via: 'cookie' }
  }

  session.jar.clear()
  if (!acc.pass) {
    throw new Error('教务会话已过期，且本地库没有保存密码（绑定时没勾「保存密码」？）—— 去 App 里重新登录')
  }
  const res = await session.login(acc.user, acc.pass)
  if (!res.ok) throw new Error(`登录失败：${res.message}`)
  return { session, account: acc, via: 'password' }
}

/**
 * 教学班是否还有位置。
 *
 * 教务**没有**「已满」这个布尔值，只能算：有上限且已选人数没到上限。
 * 与前端 `CourseSelectPage.vue::full()` 同一判据，两处必须一致。
 */
export function hasSeat(lesson) {
  const limit = lesson?.limitCount
  const std = lesson?.stdCount
  if (limit == null) return true // 教务没给上限 = 不限制
  return (std ?? 0) < limit
}

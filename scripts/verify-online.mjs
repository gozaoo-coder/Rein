#!/usr/bin/env node
/**
 * 在线服务体检 —— 一条命令走完 App 真正会用到的每条链路。
 *
 *   node scripts/verify-online.mjs                  # 用 scripts/release/release.config.json 里的地址与令牌
 *   node scripts/verify-online.mjs --keep-key        # 保留测试密钥（默认用完就删）
 *   REIN_UPDATE_BASE_URL=http://127.0.0.1:8787 node scripts/verify-online.mjs
 *
 * 为什么要单开一个脚本：在线服务的失败方式**长得都一样**（界面上就是一句「连不上」），
 * 但成因完全不同 —— 服务没起来 / 明文被系统策略挡掉 / 密钥不对 / provider 全在冷却。
 * 这里按层分开验，出错时直接告诉你坏在哪一层：
 *
 *   1. /health            —— 进程活着吗、网关 ready 吗、provider 有没有全部冷却
 *   2. 管理面签发密钥      —— 能在配置里写东西吗（systemd 把 /etc 只读挂载时这一步 500）
 *   3. /v1/models          —— 客户端密钥能不能换到目录（App 的「获取模型」走这条）
 *   4. /v1/chat/completions —— 非流式（对账、标题摘要这类）
 *   5. 同一条的 stream=true —— 聊天主路径（SSE 首包能不能及时到）
 *   6. /api/v1/ai/usage    —— 服务端权威账本（App 的成本对账）
 *   7. 清理                —— 删掉第 2 步签发的临时密钥
 */
import { loadReleaseConfig, fail, log } from './release/lib.mjs'

const args = process.argv.slice(2)
const keepKey = args.includes('--keep-key')
const cfg = loadReleaseConfig()
const BASE = (process.env.REIN_UPDATE_BASE_URL ?? cfg.serverBaseUrl ?? '').replace(/\/+$/, '')
const ADMIN = process.env.REIN_UPDATE_TOKEN ?? cfg.adminToken ?? ''

if (!BASE) fail('没有服务地址：设置 REIN_UPDATE_BASE_URL 或 scripts/release/release.config.json 的 serverBaseUrl')
if (!ADMIN) fail('没有管理令牌：设置 REIN_UPDATE_TOKEN 或 release.config.json 的 adminToken')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function req(path, { method = 'GET', token, body, raw = false, timeout = 30000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const text = await res.text()
    if (raw) return { status: res.status, text, contentType: res.headers.get('content-type') ?? '' }
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 也照样回原文给上层判断 */
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? `超时（${timeout}ms）` : String(e.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}

log(`\n▶ 在线服务体检：${BASE}`)
let tempKey = null

try {
  /* ---------- 1. 进程与网关状态 ---------- */
  log('\n1) /health —— 服务与网关是否就绪')
  const health = await req('/health', { timeout: 12000 })
  if (health.status === 0) {
    check('服务可达', false, health.error)
    throw new Error(`连不上 ${BASE}：${health.error} —— 先确认服务器在跑、安全组放行、地址没写错`)
  }
  check('服务可达', health.status === 200, `HTTP ${health.status}`)
  const ai = health.json?.ai
  check('网关就绪', ai?.status === 'ready', `status=${ai?.status ?? '(缺 ai 字段)'} enabled=${ai?.enabled}`)
  const cooling = (ai?.providers ?? []).filter((p) => p.enabled && p.coolingDown).map((p) => p.id)
  check('没有 provider 全在冷却', cooling.length < (ai?.providers ?? []).filter((p) => p.enabled).length,
    cooling.length ? `冷却中: ${cooling.join(',')}` : `启用 ${(ai?.providers ?? []).filter((p) => p.enabled).length} 个`)
  check('计价口径在位', typeof ai?.pricing?.trafficPerGb === 'number',
    `流量 ${ai?.pricing?.trafficPerGb} 元/GB · 模型 ${ai?.pricing?.modelCount} 个`)

  /* ---------- 2. 管理面能写进去吗 ---------- */
  log('\n2) 管理面签发临时密钥 —— 配置目录可写吗')
  const minted = await req('/admin/api/ai/clients', {
    method: 'POST',
    token: ADMIN,
    body: { name: `verify-online-${new Date().toISOString().slice(0, 19)}`, models: [], rpm: 120 },
  })
  if (minted.status !== 200) {
    const hint =
      minted.json?.error?.message?.includes('EROFS')
        ? '（配置目录只读：给 systemd 单元补 ReadWritePaths=/etc/rein-services 后 systemctl daemon-reload && systemctl restart rein-services）'
        : minted.status === 401
          ? '（管理令牌不对）'
          : ''
    check('能签发客户端密钥', false, `HTTP ${minted.status} ${minted.json?.error?.message ?? minted.text?.slice(0, 120)} ${hint}`)
    // 签不出来也继续用一把**假密钥**打一遍客户端接口：
    // 401 说明「链路是通的、只是密钥无效」，这和「连不上」是完全不同的两件事，
    // 而界面上它们长得一模一样。
    log('\n   （用假密钥继续探一遍链路 —— 只看「连得上吗」，不看鉴权结果）')
    const probe = await req('/v1/models', { token: 'rein_sk_invalid_for_probe', timeout: 15000 })
    const reachable = probe.status === 401
    check(
      '客户端接口可达（401 = 链路通、只是密钥无效）',
      reachable,
      probe.status === 0 ? `连不上：${probe.error}` : `HTTP ${probe.status}`,
    )
    throw new Error('管理面写不进去')
  }
  tempKey = minted.json?.token ?? null
  const clientId = minted.json?.client?.id ?? null
  check('能签发客户端密钥', !!tempKey, `id=${clientId} key=${tempKey?.slice(0, 12)}…`)

  /* ---------- 3. 目录 ---------- */
  log('\n3) /v1/models —— App 的「获取模型目录」')
  const models = await req('/v1/models', { token: tempKey, timeout: 15000 })
  const ids = (models.json?.data ?? []).map((m) => m.id)
  check('目录可取', models.status === 200 && ids.length > 0, `HTTP ${models.status} · ${ids.length} 个：${ids.slice(0, 6).join(', ')}`)
  const hasAuto = ids.includes('auto-model')
  check('带 auto-model 别名', hasAuto || ids.length > 0, hasAuto ? '有' : '（没有 auto-model，App 会按名字挑）')

  /* ---------- 4. 非流式对话 ---------- */
  const modelId = hasAuto ? 'auto-model' : ids[0]
  log(`\n4) /v1/chat/completions（非流式，model=${modelId}）`)
  const chat = await req('/v1/chat/completions', {
    method: 'POST',
    token: tempKey,
    timeout: 60000,
    body: { model: modelId, max_tokens: 24, messages: [{ role: 'user', content: '只回两个字：在的' }] },
  })
  const reply = chat.json?.choices?.[0]?.message?.content ?? ''
  check('非流式能答', chat.status === 200 && !!reply, `HTTP ${chat.status} · ${chat.status === 200 ? reply.slice(0, 40) : (chat.json?.error?.message ?? chat.text?.slice(0, 120))}`)
  if (chat.status === 200 && chat.json?.usage) {
    check('回包带 usage（对账靠它）', true, JSON.stringify(chat.json.usage))
  }

  /* ---------- 5. 流式（聊天主路径） ---------- */
  log('\n5) 同一条的 stream=true —— SSE 首包')
  const t0 = Date.now()
  const stream = await req('/v1/chat/completions', {
    method: 'POST',
    token: tempKey,
    raw: true,
    timeout: 60000,
    body: { model: modelId, stream: true, max_tokens: 24, messages: [{ role: 'user', content: '从 1 数到 3' }] },
  })
  const firstByteMs = Date.now() - t0
  const lines = (stream.text ?? '').split('\n').filter((l) => l.trim())
  const hasDone = /\[DONE\]/.test(stream.text ?? '')
  const hasDelta = lines.some((l) => l.includes('"delta"') || l.includes('"content"'))
  check('流式首包到达', stream.status === 200 && !stream.error, stream.error ?? `HTTP ${stream.status} · ${firstByteMs}ms 内拿到 ${lines.length} 行`)
  check('SSE 形状正确', hasDelta && hasDone, `delta=${hasDelta} [DONE]=${hasDone}`)

  /* ---------- 6. 账本 ---------- */
  log('\n6) /api/v1/ai/usage —— 服务端权威账本')
  const usage = await req('/api/v1/ai/usage?days=7', { token: tempKey, timeout: 15000 })
  const u = usage.json?.data ?? usage.json
  check('能读到自己这把密钥的用量', usage.status === 200, `HTTP ${usage.status} · ${JSON.stringify(u).slice(0, 160)}`)
} catch (e) {
  if (!String(e.message ?? '').startsWith('连不上') && !String(e.message ?? '').includes('管理面写不进去')) {
    check('体检过程无异常', false, String(e.message ?? e))
  }
} finally {
  /* ---------- 7. 清理 ---------- */
  const id = tempKey ? (await req('/admin/api/ai/state', { token: ADMIN })).json?.clients?.find((c) => c.name?.startsWith('verify-online-'))?.id : null
  if (tempKey && id && !keepKey) {
    const del = await req(`/admin/api/ai/clients/${id}`, { method: 'DELETE', token: ADMIN })
    console.log(`\n7) 清理：${del.status === 200 ? `已删除临时密钥 ${id}` : `删除失败 HTTP ${del.status}（请手工删 ${id}）`}`)
  } else if (keepKey) {
    console.log('\n7) 清理：--keep-key，保留临时密钥')
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
// 用 exitCode 而不是 process.exit()：undici 还有 keep-alive 连接在关，
// 立刻退出会在 libuv 里撞上 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
process.exitCode = failed > 0 ? 1 : 0

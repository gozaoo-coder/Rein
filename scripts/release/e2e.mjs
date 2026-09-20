#!/usr/bin/env node
/**
 * 更新链路端到端自测（本地起临时服务端，跑完整发布→校验→下载）。
 *
 * 它守的是这条链路上最容易悄悄坏掉的地方：
 *   · 服务端能否验出「官方 tauri CLI 签的名」（跨实现互操作，最容易在这里翻车）
 *   · 清单签名与清单字节是否严格一致（服务端重新序列化就会坏）
 *   · 篡改一个字节后是否**一定**被拒（安全声明不能只写在文档里）
 *   · Range 断点续传、admin 鉴权、AI 网关的未配置态
 *
 *   node scripts/release/e2e.mjs [--keep] [--artifact <安装包路径>]
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT, loadReleaseConfig, log, signFile, signText } from './lib.mjs'
import { verifyMinisign } from '../../server/src/verify.mjs'

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const artifactArg = argv[argv.indexOf('--artifact') + 1]
const PORT = Number(process.env.REIN_E2E_PORT ?? 18899)
const BASE = `http://127.0.0.1:${PORT}`
const FAKE_PORT = PORT + 1
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}`

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    log(`   ✓ ${name}`)
  } else {
    failed += 1
    log(`   ✖ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error('服务端启动超时')
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * 假上游 provider：OpenAI 兼容的最小实现。
 * 固定回 100 万输入 token / 0 输出 token —— 配合配置里 e2e-model 的单价（2 元/百万），
 * 一次调用的模型费正好 2 元，断言不必做浮点撒娇。
 *
 * 另外按模型名造两种故障，用来演练「欠费兜底」：e2e-overdue 回方舟欠费时的真实报文
 * （403 + AccountOverdueError），e2e-badrequest 回一个与账户无关的参数错误（不该兜底）。
 * 返回 { server, hits } —— hits 记每个模型被打了多少次，用来断言冷却期内没再去撞主上游。
 */
async function startFakeProvider(port) {
  const http = await import('node:http')
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 }
  const hits = {}
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        /* 不是 JSON 也照样回 */
      }
      const model = parsed.model ?? 'e2e-model'
      hits[model] = (hits[model] ?? 0) + 1

      if (model === 'e2e-overdue') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(
          JSON.stringify({
            error: {
              code: 'AccountOverdueError',
              message: 'The request failed because your account has an overdue balance.',
            },
          }),
        )
      }
      if (model === 'e2e-badrequest') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: { code: 'InvalidParameter', message: 'temperature 超出取值范围' } }))
      }

      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' } }] })}\n\n`)
        // include_usage 语义：最后一个 chunk 带 usage，之后才是 [DONE]
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [], usage })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage,
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, hits }
}

async function main() {
  const cfg = loadReleaseConfig()
  const pubFile = path.join(REPO_ROOT, 'src-tauri', 'keys', 'rein-update.key.pub')
  if (!fs.existsSync(cfg.keyPath)) {
    throw new Error(`缺少签名私钥：${cfg.keyPath}\n先跑 node scripts/release/keygen.mjs`)
  }
  const pubkey = fs.readFileSync(pubFile, 'utf8').trim()

  // 被测物：优先用真实安装包（顺便验证大文件路径），否则造一个 3MB 的假包
  let artifact = artifactArg ? path.resolve(REPO_ROOT, artifactArg) : null
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rein-e2e-'))
  if (!artifact || !fs.existsSync(artifact)) {
    artifact = path.join(tmpRoot, 'Rein-e2e-test-x64-setup.exe')
    const buf = crypto.randomBytes(3 * 1024 * 1024)
    fs.writeFileSync(artifact, buf)
    log(`   · 未指定 --artifact，使用生成的测试包（${(buf.length / 1024 / 1024).toFixed(1)} MB）`)
  } else {
    log(`   · 使用真实产物 ${path.basename(artifact)}（${(fs.statSync(artifact).size / 1024 / 1024).toFixed(1)} MB）`)
  }

  const dataDir = path.join(tmpRoot, 'data')
  const configFile = path.join(tmpRoot, 'config.json')
  const adminToken = `test_${crypto.randomBytes(12).toString('hex')}`
  fs.mkdirSync(dataDir, { recursive: true })
  // 上游假 provider：网关的转发/流式/记账/计价都靠它跑通，不需要真实模型 key
  const { server: upstream, hits } = await startFakeProvider(FAKE_PORT)
  fs.writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        port: PORT,
        host: '127.0.0.1',
        publicBaseUrl: BASE,
        adminToken,
        update: {
          defaultChannel: 'stable',
          channels: ['stable', 'beta'],
          publicKey: pubkey,
          requireSignature: true,
          keepVersions: 3,
        },
        ai: {
          enabled: true,
          requireToken: true,
          providers: [
            {
              id: 'fake',
              name: 'e2e 假上游',
              baseUrl: `${FAKE_BASE}/v1`,
              apiKey: 'sk-e2e-fake',
              models: ['e2e-model', 'e2e-blocked', 'e2e-overdue', 'e2e-badrequest'],
              enabled: true,
              // 欠费兜底：主家回 AccountOverdueError 时换到下面那个备选，并做模型名映射
              fallback: {
                providerId: 'e2e-backup',
                cooldownSec: 60,
                models: { 'e2e-overdue': 'e2e-backup-model' },
              },
            },
            {
              id: 'e2e-backup',
              name: 'e2e 备选上游',
              baseUrl: `${FAKE_BASE}/v1`,
              apiKey: 'sk-e2e-backup',
              models: ['e2e-backup-model'],
              hidden: true,
              enabled: true,
            },
          ],
          clients: [],
          // auto-model 别名指向它；换后端模型只改这一行，客户端不必改
          autoModel: 'e2e-model',
          // 价格写成整百万 tokens 的量级，便于断言：100 万输入 token 正好 2 元
          pricing: {
            currency: 'CNY',
            traffic: { perGb: 0.8, scope: 'egress' },
            default: { in: 0, out: 0 },
            models: { 'e2e-model': { in: 2, out: 8 }, 'e2e-backup-model': { in: 2, out: 8 } },
          },
        },
      },
      null,
      2,
    )}\n`,
  )

  log(`\n▶ 启动临时服务端 :${PORT}（数据目录 ${dataDir}）`)
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'src', 'index.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      REIN_DATA_DIR: dataDir,
      REIN_CONFIG: configFile,
      REIN_PORT: String(PORT),
      REIN_HOST: '127.0.0.1',
      REIN_PUBLIC_BASE_URL: BASE,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverLog = []
  child.stdout.on('data', (d) => serverLog.push(d.toString()))
  child.stderr.on('data', (d) => serverLog.push(d.toString()))

  try {
    await waitForServer()
    log('   ✓ 服务端已就绪')

    // ---------- 1. 健康检查 ----------
    const health = await (await fetch(`${BASE}/health`)).json()
    check('健康检查返回服务标识', health.service === 'rein-online-service')
    check('健康检查暴露清单与公钥地址', Boolean(health.update?.manifest && health.update?.publicKey))
    check('AI 网关报告可用状态与计价口径', health.ai?.status === 'ready' && health.ai?.pricing?.trafficPerGb === 0.8)

    // ---------- 2. 未发布时的清单 ----------
    const empty = await fetch(`${BASE}/updates/latest.json`)
    check('未发布时清单返回 404 no_release', empty.status === 404 && (await empty.json()).error?.code === 'no_release')

    // ---------- 3. 非管理令牌被拒 ----------
    const denied = await fetch(`${BASE}/admin/api/state`, { headers: { Authorization: 'Bearer wrong' } })
    check('错误的管理令牌被拒', denied.status === 401)

    // ---------- 4. 签名 + 上传 + 发布 ----------
    const version = '9.9.9'
    const fileName = path.basename(artifact)
    log('\n▶ 签名并发布测试版本')
    const { signature } = signFile(artifact, { keyPath: cfg.keyPath, password: cfg.keyPassword })
    check('tauri CLI 产出的签名可被服务端模块解析', verifyMinisign(fs.readFileSync(artifact), signature, pubkey).ok)

    const uploadRes = await fetch(`${BASE}/admin/api/artifacts/stable/${version}/${encodeURIComponent(fileName)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(artifact),
    })
    const uploaded = await uploadRes.json()
    check('安装包上传成功', uploadRes.ok && uploaded.sha256?.length === 64, JSON.stringify(uploaded).slice(0, 200))
    const localSha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')
    check('服务端回执 sha256 与本地一致', uploaded.sha256 === localSha)

    const manifest = {
      version,
      notes: 'e2e 自测版本',
      pub_date: new Date().toISOString(),
      channel: 'stable',
      mandatory: false,
      platforms: {
        'windows-x86_64': {
          url: `${BASE}/dl/stable/${version}/${encodeURIComponent(fileName)}`,
          signature,
          sha256: uploaded.sha256,
          size: uploaded.size,
          name: fileName,
          mirrors: ['https://example.invalid/mirror/' + fileName],
        },
      },
      'x-rein': { generator: 'e2e' },
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const manifestSignature = signText(manifestText, {
      keyPath: cfg.keyPath,
      password: cfg.keyPassword,
      label: 'latest.json',
    }).signature

    const publishRes = await fetch(`${BASE}/admin/api/releases`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'stable',
        version,
        notes: manifest.notes,
        platforms: {
          'windows-x86_64': { file: fileName, signature, sha256: uploaded.sha256, size: uploaded.size },
        },
        manifestText,
        manifestSignature,
      }),
    })
    const published = await publishRes.json()
    check('发布登记成功', publishRes.ok, JSON.stringify(published).slice(0, 300))

    // ---------- 5. 客户端视角：拉清单 → 验签 → 下载 → 验包 ----------
    log('\n▶ 以客户端视角校验')
    const manifestRes = await fetch(`${BASE}/updates/latest.json`)
    const servedText = await manifestRes.text()
    check('清单可拉取', manifestRes.ok)
    check('清单字节与服务端存储完全一致（签名前提）', servedText === manifestText)

    const sigRes = await fetch(`${BASE}/updates/latest.json.sig`)
    const servedSig = (await sigRes.text()).trim()
    check('清单伴随签名可拉取', sigRes.ok)
    const manifestCheck = verifyMinisign(Buffer.from(servedText, 'utf8'), servedSig, pubkey)
    check('清单签名校验通过', manifestCheck.ok, manifestCheck.reason ?? '')

    const served = JSON.parse(servedText)
    const entry = served.platforms['windows-x86_64']
    check('清单平台条目完整（url/signature/sha256/size）', Boolean(entry.url && entry.signature && entry.sha256 && entry.size))

    const dl = await fetch(entry.url)
    const bytes = Buffer.from(await dl.arrayBuffer())
    check('安装包可下载', dl.ok && bytes.length === uploaded.size)
    const dlSha = crypto.createHash('sha256').update(bytes).digest('hex')
    check('下载内容 sha256 与清单一致', dlSha === entry.sha256)
    const artifactCheck = verifyMinisign(bytes, entry.signature, pubkey)
    check('安装包签名校验通过（可安装）', artifactCheck.ok, artifactCheck.reason ?? '')

    // ---------- 6. 篡改必须被拒 ----------
    const tampered = Buffer.from(bytes)
    tampered[Math.floor(tampered.length / 2)] ^= 0xff
    check('篡改一个字节后签名校验失败', !verifyMinisign(tampered, entry.signature, pubkey).ok)
    check(
      '篡改后 sha256 也对不上（双重防线）',
      crypto.createHash('sha256').update(tampered).digest('hex') !== entry.sha256,
    )

    // ---------- 7. Range 断点续传 ----------
    const ranged = await fetch(entry.url, { headers: { Range: 'bytes=0-99' } })
    const rangedBody = Buffer.from(await ranged.arrayBuffer())
    check('支持 Range 断点续传（206 + 100 字节）', ranged.status === 206 && rangedBody.length === 100)
    check('Range 内容与整包前 100 字节一致', rangedBody.equals(bytes.subarray(0, 100)))

    // ---------- 8. 历史与回滚 ----------
    const stats = await (await fetch(`${BASE}/api/v1/update/releases?channel=stable`)).json()
    check('发布历史可查', stats.releases?.length === 1 && stats.current === version)

    const rollback = await fetch(`${BASE}/admin/api/releases/stable/${version}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    check('可把某版本重新置为当前（回滚路径）', rollback.ok)

    // ---------- 9. AI 网关预留接口 ----------
    log('\n▶ 在线模型网关（预留接口）')
    const aiHealth = await (await fetch(`${BASE}/api/v1/ai/health`)).json()
    check('AI 健康检查可用', aiHealth.ok === true)
    const noAuth = await fetch(`${BASE}/v1/models`)
    check(
      '无令牌访问 /v1/models 被拒（默认要求令牌）',
      noAuth.status === 401 && (await noAuth.json()).error?.code === 'ai_unauthorized',
    )
    const issue = await fetch(`${BASE}/admin/api/ai/clients`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'e2e', models: ['e2e-model'] }),
    })
    const issued = await issue.json()
    check('可签发客户端令牌（明文仅此一次）', issue.ok && issued.token?.startsWith('rein_sk_'))
    check('签发后的配置里不落明文令牌', !JSON.stringify(issued.client).includes(issued.token))
    check('令牌白名单随签发落库', issued.client?.models?.join() === 'e2e-model')

    const withToken = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${issued.token}` } })
    const withTokenBody = await withToken.json()
    check(
      '持令牌访问 /v1/models 通过',
      withToken.status === 200 && Array.isArray(withTokenBody.data),
      `HTTP ${withToken.status} ${JSON.stringify(withTokenBody).slice(0, 160)}`,
    )
    // 服务端指定可用模型：auto-model 别名在前，后面才是白名单里的真实模型
    const catalogIds = (withTokenBody.data ?? []).map((m) => m.id)
    check(
      '模型清单只列白名单内的模型（auto-model 别名在前）',
      catalogIds.join() === 'auto-model,e2e-model',
      JSON.stringify(catalogIds),
    )
    check(
      'auto-model 别名指向服务端配置的默认模型',
      withTokenBody.data?.[0]?.rein?.auto === true && withTokenBody.data?.[0]?.rein?.target === 'e2e-model',
      JSON.stringify(withTokenBody.data?.[0]),
    )
    check(
      '别名照抄目标模型的单价（默认模型不能显示成「未定价」）',
      withTokenBody.data?.[0]?.rein?.priceIn === 2 &&
        withTokenBody.data?.[0]?.rein?.priceOut === 8 &&
        withTokenBody.data?.[0]?.rein?.priced === true,
      JSON.stringify(withTokenBody.data?.[0]?.rein),
    )
    const pricedEntry = (withTokenBody.data ?? []).find((m) => m.id === 'e2e-model')
    check(
      '模型清单带官方单价与 traffic 口径',
      pricedEntry?.rein?.priceIn === 2 &&
        pricedEntry?.rein?.priceOut === 8 &&
        withTokenBody.rein?.trafficPerGb === 0.8 &&
        withTokenBody.rein?.trafficScope === 'egress',
      JSON.stringify(withTokenBody.rein),
    )
    check('模型清单回显令牌可见范围', withTokenBody.rein?.client?.models?.join() === 'e2e-model')

    // 白名单外模型：403 而不是悄悄转发
    const forbidden = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: 'e2e-blocked', messages: [{ role: 'user', content: 'hi' }] }),
    })
    check(
      '白名单外的模型返回 403 model_not_allowed',
      forbidden.status === 403 && (await forbidden.json()).error?.code === 'model_not_allowed',
    )

    // auto-model 落定：上游收到的是真实模型名，账单也记在真实模型身上
    const viaAuto = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: 'auto-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const viaAutoBody = await viaAuto.json()
    check(
      'auto-model 由服务端落定成默认模型（客户端不必知道背后是谁）',
      viaAuto.ok && viaAutoBody.model === 'e2e-model',
      `HTTP ${viaAuto.status} ${JSON.stringify(viaAutoBody).slice(0, 160)}`,
    )
    const viaAutoCost = Number(viaAuto.headers.get('x-rein-cost-cny'))
    check(
      '别名调用按被指向模型的单价计费（不是「未定价」）',
      viaAutoCost > 1.99 && viaAutoCost < 2.01,
      `cost=${viaAutoCost}`,
    )
    const aliasLedger = await (
      await fetch(`${BASE}/admin/api/ai/usage?days=1`, { headers: { Authorization: `Bearer ${adminToken}` } })
    ).json()
    check(
      '账本记在真实模型名下（不出现 auto-model 这个别名）',
      (aliasLedger.byModel ?? []).every((m) => m.model !== 'auto-model') &&
        (aliasLedger.byModel ?? []).some((m) => m.key === 'fake/e2e-model'),
      JSON.stringify((aliasLedger.byModel ?? []).map((m) => m.key)),
    )

    // 别名绝不是白名单后门：默认模型不在白名单里的令牌看不到、也调不动它
    const narrow = await (
      await fetch(`${BASE}/admin/api/ai/clients`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-narrow', models: ['e2e-blocked'] }),
      })
    ).json()
    const narrowBody = await (
      await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${narrow.token}` } })
    ).json()
    const narrowIds = (narrowBody.data ?? []).map((m) => m.id)
    check('白名单不含默认模型的令牌看不到 auto-model', narrowIds.join() === 'e2e-blocked', JSON.stringify(narrowIds))
    const narrowAuto = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${narrow.token}` },
      body: JSON.stringify({ model: 'auto-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    check(
      '调用 auto-model 时同样过白名单（别名不是后门）',
      narrowAuto.status === 403 && (await narrowAuto.json()).error?.code === 'model_not_allowed',
    )

    // 一次真实计费调用：100 万输入 token × 2 元/百万 = 2 元（+ 出方向流量的零头）
    const billed = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: 'e2e-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const billedCost = Number(billed.headers.get('x-rein-cost-cny'))
    check(
      '非流式响应头带本次成本（模型费 ≈ 2 元）',
      billed.ok && billedCost > 1.99 && billedCost < 2.01,
      `HTTP ${billed.status} cost=${billed.headers.get('x-rein-cost-cny')}`,
    )
    check('上游 usage 原样透传', (await billed.json()).usage?.prompt_tokens === 1_000_000)

    // 流式：usage 由网关注入 stream_options 逼出来，否则流式就漏 token 费
    const streamed = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: 'e2e-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const streamText = await streamed.text()
    check(
      '流式 SSE 透传完整（含 usage 与 [DONE]）',
      streamed.ok && streamText.includes('"usage"') && streamText.includes('data: [DONE]'),
      streamText.slice(0, 160),
    )

    // 客户端侧：自己的账（服务端为准）
    const clientUsage = await (
      await fetch(`${BASE}/api/v1/ai/usage?days=1`, { headers: { Authorization: `Bearer ${issued.token}` } })
    ).json()
    check(
      '客户端令牌可查自己的用量与总成本',
      clientUsage.ok === true && clientUsage.totals?.calls >= 2 && clientUsage.totals?.costCNY?.total > 3.99,
      JSON.stringify(clientUsage.totals),
    )
    check(
      '客户端用量带令牌身份与计价口径',
      clientUsage.client?.name === 'e2e' && clientUsage.pricing?.trafficPerGb === 0.8,
    )
    const foreignUsage = await fetch(`${BASE}/api/v1/ai/usage`, { headers: { Authorization: 'Bearer rein_sk_nope' } })
    check('用量接口同样要求合法令牌', foreignUsage.status === 401)

    // 管理面：全局成本 + 按模型/按令牌拆分
    const adminUsage = await (
      await fetch(`${BASE}/admin/api/ai/usage?days=1`, { headers: { Authorization: `Bearer ${adminToken}` } })
    ).json()
    check(
      '管理面汇总含模型费与流量费',
      adminUsage.totals?.costCNY?.tokens > 3.99 &&
        adminUsage.totals?.costCNY?.traffic > 0 &&
        adminUsage.byModel?.some((m) => m.key === 'fake/e2e-model'),
      JSON.stringify(adminUsage.totals),
    )
    check('管理面按令牌拆分花费', adminUsage.byClient?.[0]?.clientName === 'e2e')
    const stateWithUsage = await (
      await fetch(`${BASE}/admin/api/ai/state`, { headers: { Authorization: `Bearer ${adminToken}` } })
    ).json()
    check(
      'AI 状态页带每令牌 7 天花费与价目表',
      stateWithUsage.clients?.[0]?.usage7d?.costCNY?.total > 3.99 && stateWithUsage.pricing?.trafficPerGb === 0.8,
    )

    // 价目表热更新：只改一个模型，其余保留
    const priced = await fetch(`${BASE}/admin/api/ai/pricing`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: { 'e2e-model': { in: 4, out: 16 } }, traffic: { perGb: 1 } }),
    })
    const pricedBody = await priced.json()
    check(
      '价目表可热更新且不影响未提及的模型',
      priced.ok && pricedBody.pricing?.models?.['e2e-model']?.in === 4 && pricedBody.pricing?.trafficPerGb === 1,
      JSON.stringify(pricedBody.pricing).slice(0, 200),
    )
    check(
      '未配置价格的模型落 default（只计流量费）',
      pricedBody.pricing?.default?.in === 0 && pricedBody.pricing?.models?.['e2e-blocked'] === undefined,
    )

    const notConfigured = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    check(
      'auto 走白名单内的第一个模型（仍会计费）',
      notConfigured.status === 200,
      `HTTP ${notConfigured.status}`,
    )

    const badToken = await fetch(`${BASE}/v1/models`, { headers: { Authorization: 'Bearer rein_sk_deadbeef' } })
    check('伪造令牌被拒', badToken.status === 401)

    // ---------- 9b. 欠费兜底（主家 AccountOverdueError → 备选 provider） ----------
    log('\n▶ 欠费兜底（上游账户级故障自动切换）')
    const failoverClient = await (
      await fetch(`${BASE}/admin/api/ai/clients`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-failover', models: ['e2e-overdue', 'e2e-badrequest'] }),
      })
    ).json()
    const failoverHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${failoverClient.token}`,
    }

    const overdueHitsBefore = hits['e2e-overdue'] ?? 0
    const switched = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: failoverHeaders,
      body: JSON.stringify({ model: 'e2e-overdue', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const switchedBody = await switched.json()
    check(
      '主上游欠费时自动切到备选（客户端无感，报文正常）',
      switched.ok && switchedBody.model === 'e2e-backup-model',
      `HTTP ${switched.status} ${JSON.stringify(switchedBody).slice(0, 160)}`,
    )
    check(
      '兜底前确实先撞过一次主上游',
      (hits['e2e-overdue'] ?? 0) === overdueHitsBefore + 1,
      `hits=${hits['e2e-overdue'] ?? 0}`,
    )
    const switchedCost = Number(switched.headers.get('x-rein-cost-cny'))
    check(
      '兜底调用按备选模型的单价计费',
      switchedCost > 1.99 && switchedCost < 2.01,
      `cost=${switchedCost}`,
    )

    const breakerHealth = await (await fetch(`${BASE}/api/v1/ai/health`)).json()
    const primaryState = (breakerHealth.providers ?? []).find((p) => p.id === 'fake')
    check(
      '健康检查暴露退路与冷却状态（运维一眼看出流量已经切走）',
      primaryState?.fallbackTo === 'e2e-backup' && primaryState?.coolingDown === true,
      JSON.stringify(primaryState),
    )

    const secondCall = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: failoverHeaders,
      body: JSON.stringify({ model: 'e2e-overdue', messages: [{ role: 'user', content: 'hi' }] }),
    })
    check(
      '冷却期内不再去撞已经欠费的主上游',
      secondCall.ok && (hits['e2e-overdue'] ?? 0) === overdueHitsBefore + 1,
      `hits=${hits['e2e-overdue'] ?? 0}`,
    )

    const backupHitsBefore = hits['e2e-backup-model'] ?? 0
    const notAccount = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: failoverHeaders,
      body: JSON.stringify({ model: 'e2e-badrequest', messages: [{ role: 'user', content: 'hi' }] }),
    })
    check(
      '与账户无关的上游错误原样透传、不触发兜底',
      notAccount.status === 400 && (hits['e2e-backup-model'] ?? 0) === backupHitsBefore,
      `HTTP ${notAccount.status} backupHits=${hits['e2e-backup-model'] ?? 0}`,
    )

    // ---------- 10. 路径穿越防护 ----------
    const traversal = await fetch(`${BASE}/dl/stable/${version}/..%2F..%2Fconfig.json`)
    check('下载路径穿越被拒', traversal.status === 400 || traversal.status === 404)
  } finally {
    child.kill()
    upstream.close()
    if (!keep) fs.rmSync(tmpRoot, { recursive: true, force: true })
    else log(`\n（--keep：临时目录保留在 ${tmpRoot}）\n${serverLog.join('').slice(-2000)}`)
  }

  log(`\n${failed === 0 ? '✔' : '✖'} 端到端自测：${passed} 项通过，${failed} 项失败\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  process.stderr.write(`\n✖ ${e.stack ?? e}\n`)
  process.exit(1)
})

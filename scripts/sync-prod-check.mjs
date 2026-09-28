/**
 * 对着线上服务跑一遍同步会合的三件套（配对 / 认领 / 中继），确认部署真的生效。
 * 只用假的设备号与公钥，不碰任何业务数据、不落盘。
 */
const BASE = process.env.REIN_BASE ?? 'http://47.100.36.179:8787'
const b64 = (s) => Buffer.from(s).toString('base64')

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 就留 null，下面打原文 */
  }
  return { status: res.status, json, text }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 同上 */
  }
  return { status: res.status, json, text }
}

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failed += 1
}

async function main() {
  const health = await get('/health')
  check('health', health.status === 200, `HTTP ${health.status}`)

  const stamp = Date.now().toString(36)
  const a = { device: `probe-a-${stamp}`, pub: b64(`pub-a-${stamp}`) }
  const b = { device: `probe-b-${stamp}`, pub: b64(`pub-b-${stamp}`) }
  // 房间号与客户端同规则：32 位十六进制（随机、不可猜，服务端按这个校验）
  const room = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

  const opened = await post('/api/v1/sync/pair', a)
  check('开码', opened.status === 200 && !!opened.json?.code, JSON.stringify(opened.json ?? opened.text))
  const code = opened.json?.code
  if (!code) return

  const claimed = await post(`/api/v1/sync/pair/${code}`, { ...b, room })
  const peerOfB = claimed.json?.peer
  check('认领并拿到对方公钥', claimed.status === 200 && peerOfB?.device === a.device, JSON.stringify(claimed.json ?? claimed.text))

  const polled = await get(`/api/v1/sync/pair/${code}`)
  // 有对端时回 {peer}，还没人认领时回 {pending:true} —— 两种都算「按契约回答」
  const polledOk = polled.status === 200 && polled.json?.pending !== true && polled.json?.peer?.device === b.device
  check('开码侧取回对方', polledOk, JSON.stringify(polled.json ?? polled.text))

  const used = await get(`/api/v1/sync/pair/${code}`)
  check('码用过即废', used.status !== 200 || used.json?.pending === true, JSON.stringify(used.json ?? used.text))

  const frame = b64('frame-1')
  const sent = await post(`/api/v1/sync/relay/${room}`, { frames: [frame] })
  check('中继投递', sent.status === 200 && typeof sent.json?.seq === 'number', JSON.stringify(sent.json ?? sent.text))

  const fetched = await get(`/api/v1/sync/relay/${room}?after=0&wait=200`)
  const got = fetched.json?.frames?.[0]
  check('中继取件', got?.data === frame, JSON.stringify(fetched.json ?? fetched.text))

  const empty = await get(`/api/v1/sync/relay/${room}?after=${fetched.json?.lastSeq ?? 1}&wait=200`)
  check('取完就空（不重复给）', (empty.json?.frames?.length ?? -1) === 0, JSON.stringify(empty.json ?? empty.text))

  console.log(failed === 0 ? '\n线上同步链路：全部通过' : `\n线上同步链路：${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('probe failed:', e?.message ?? e)
  process.exit(1)
})

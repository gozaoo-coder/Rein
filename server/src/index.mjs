#!/usr/bin/env node
/**
 * Rein 在线服务入口。
 *
 * 一台 1.6G 内存的 ECS 上同时跑着 OpenClaw 与 QQ，所以这里刻意保持「零依赖 + 单进程」：
 * 没有 npm install，没有构建步骤，`git pull && systemctl restart` 就是全部部署流程。
 *
 * 用法：
 *   node src/index.mjs                 # 用 server/config.json
 *   REIN_PORT=8787 node src/index.mjs  # 端口从环境变量覆盖
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { createRouter } from './routes.mjs'
import { AiGateway } from './ai.mjs'
import { Store } from './store.mjs'
import { nowIso, sendError } from './util.mjs'

const { cfg, created } = loadConfig()

const logDir = path.join(cfg.dataDir, 'logs')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `server-${new Date().toISOString().slice(0, 10)}.jsonl`)

function log(event, detail = {}) {
  const line = JSON.stringify({ ts: nowIso(), event, ...detail })
  process.stdout.write(`${line}\n`)
  try {
    fs.appendFileSync(logFile, `${line}\n`)
  } catch {
    /* 日志写不进去不能影响服务 */
  }
}

const store = new Store(cfg, log)
const ai = new AiGateway(cfg, log)
const router = createRouter({ cfg, store, ai, log })

const server = http.createServer((req, res) => {
  const started = Date.now()
  let url
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    return sendError(res, 400, 'bad_request', '非法 URL')
  }

  res.on('finish', () => {
    // 静态分发与健康检查量大且无信息量，只记管理面与错误
    if (res.statusCode >= 400 || url.pathname.startsWith('/admin')) {
      log('http', {
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
        ip: req.socket?.remoteAddress ?? null,
      })
    }
  })

  Promise.resolve(router.handle(req, res, url)).catch((e) => {
    const status = e?.status ?? 500
    log('error', { path: url.pathname, status, error: String(e?.message ?? e), stack: e?.stack })
    if (!res.headersSent) {
      sendError(res, status, status === 500 ? 'internal_error' : 'bad_request', String(e?.message ?? e))
    } else {
      res.end()
    }
  })
})

server.on('clientError', (err, socket) => {
  log('client-error', { error: err.message })
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000

server.listen(cfg.port, cfg.host, () => {
  const banner = [
    '',
    '┌─ Rein 在线服务 ────────────────────────────────────────────────',
    `│ 监听          http://${cfg.host}:${cfg.port}`,
    `│ 对外地址      ${cfg.publicBaseUrl}`,
    `│ 数据目录      ${cfg.dataDir}`,
    `│ 配置文件      ${cfg.configFile}`,
    `│ 更新公钥      ${cfg.update.publicKey ? '已配置' : '未配置（发布方上传后才会校验签名）'}`,
    `│ 通道          ${cfg.update.channels.join(', ')}（默认 ${cfg.update.defaultChannel}）`,
    `│ 模型网关      ${ai.health().status}（预留接口，/v1/chat/completions）`,
    '└────────────────────────────────────────────────────────────────',
    '',
  ].join('\n')
  process.stdout.write(`${banner}\n`)

  if (created) {
    process.stdout.write(
      `⚠ 首次启动已生成管理令牌（请妥善保存，后续可在 ${cfg.configFile} 里改）：\n   ${cfg.adminToken}\n\n`,
    )
  }
})

function shutdown(signal) {
  log('shutdown', { signal })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (e) => log('unhandled-rejection', { error: String(e) }))
process.on('uncaughtException', (e) => log('uncaught-exception', { error: String(e), stack: e?.stack }))

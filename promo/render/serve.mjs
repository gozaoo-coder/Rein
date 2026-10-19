/** 一个够用的静态文件服务器：把 vite build 的 dist/ 挂在一个临时端口上。 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
}

export function serve(dir, { port = 0, host = '127.0.0.1' } = {}) {
  const root = resolve(dir)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      let path = decodeURIComponent(url.pathname)
      if (path.endsWith('/')) path += 'index.html'
      const file = join(root, normalize(path))
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden')
        return
      }
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((ok, fail) => {
    server.on('error', fail)
    server.listen(port, host, () => {
      const addr = server.address()
      ok({
        port: addr.port,
        url: `http://${host}:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'

// Dev-only static server for manually debugging the dashboard UI in a plain
// browser. Serves the repo root so tests/fixtures/dashboard-resize.html (which
// mocks chrome.* with fake tabs) can load the built extension/dist/app.js.
// The extension itself ships no server — this is purely a local debugging aid.
// See docs/debugging-the-dashboard.md.

const ROOT = resolve('.')
const PORT = Number(process.env.PORT) || 8765
const CONTENT_TYPES = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml'
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const target = resolve(ROOT, `.${decodeURIComponent(url.pathname)}`)
  if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end('Not found')
    return
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(target)] || 'application/octet-stream' })
  createReadStream(target).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Tab Out debug server  http://127.0.0.1:${PORT}\n`)
  process.stdout.write(`Dashboard fixture      http://127.0.0.1:${PORT}/tests/fixtures/dashboard-resize.html\n`)
})

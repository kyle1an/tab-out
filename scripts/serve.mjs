import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'

// Dev-only static server for manually debugging the dashboard UI in a plain
// browser. Serves the repo root so tests/fixtures/dashboard-resize.html (which
// mocks chrome.* with fake tabs) can load the built extension/dist/app.js.
// The extension itself ships no server — this is purely a local debugging aid.
// See docs/debugging-the-dashboard.md.

const ROOT = resolve('.')
const PORT = Number(process.env.PORT) || 8765
const DASHBOARD_FIXTURE = resolve(ROOT, 'tests/fixtures/dashboard-resize.html')
const GENERATED_INDEX = resolve(ROOT, 'extension/index.html')
const APP_ROOT_START = '<!-- TAB_OUT_APP_ROOT_START -->'
const APP_ROOT_END = '<!-- TAB_OUT_APP_ROOT_END -->'
const CONTENT_TYPES = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml'
}

function markedAppRoot(source) {
  const start = source.indexOf(APP_ROOT_START)
  const end = source.indexOf(APP_ROOT_END, start)
  if (start < 0 || end < 0) throw new Error('Dashboard page is missing generated app-root markers')
  return source.slice(start, end + APP_ROOT_END.length)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const target = resolve(ROOT, `.${decodeURIComponent(url.pathname)}`)
  if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end('Not found')
    return
  }
  if (target === DASHBOARD_FIXTURE) {
    try {
      const [fixture, generatedIndex] = await Promise.all([
        readFile(DASHBOARD_FIXTURE, 'utf8'),
        readFile(GENERATED_INDEX, 'utf8')
      ])
      const fixtureStart = fixture.indexOf(APP_ROOT_START)
      const fixtureEnd = fixture.indexOf(APP_ROOT_END, fixtureStart)
      if (fixtureStart < 0 || fixtureEnd < 0) throw new Error('Dashboard fixture is missing app-root markers')
      const body = fixture.slice(0, fixtureStart) + markedAppRoot(generatedIndex) +
        fixture.slice(fixtureEnd + APP_ROOT_END.length)
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(body)
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error))
    }
    return
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(target)] || 'application/octet-stream' })
  createReadStream(target).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Tab Out debug server  http://127.0.0.1:${PORT}\n`)
  process.stdout.write(`Dashboard fixture      http://127.0.0.1:${PORT}/tests/fixtures/dashboard-resize.html\n`)
})

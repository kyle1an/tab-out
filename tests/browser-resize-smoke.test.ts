import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean)
const RUN_BROWSER_SMOKE = process.env.RUN_BROWSER_SMOKE === '1' || !!process.env.CI

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function serveRepo(): Promise<{ server: Server; origin: string }> {
  const root = resolve('.')
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)
    const target = resolve(root, `.${pathname}`)
    if (!target.startsWith(root)) {
      res.writeHead(403).end()
      return
    }

    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end()
      return
    }
    const contentType = target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.html') ? 'text/html' : 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    createReadStream(target).pipe(res)
  })

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` })
    })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createTcpServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      server.close(() => resolvePort(address.port))
    })
  })
}

function waitForChromeExit(chrome: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      chrome.off('exit', onExit)
      resolveStop(false)
    }, timeoutMs)
    function onExit() {
      clearTimeout(timeout)
      resolveStop(true)
    }
    chrome.once('exit', onExit)
  })
}

async function stopChrome(chrome: ChildProcessWithoutNullStreams, session: CdpSession | null = null) {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return

  if (session) {
    try {
      await session.send('Browser.close')
    } catch {}
    if (await waitForChromeExit(chrome, 5000)) return
  }

  if (chrome.exitCode !== null || chrome.signalCode !== null) return
  chrome.kill('SIGTERM')
  await waitForChromeExit(chrome, 3000)
}

function rejectPending(pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>, error: Error) {
  for (const { reject } of pending.values()) {
    reject(error)
  }
  pending.clear()
}

function wait(delay: number) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delay))
}

async function waitForDevtools(port: number, chrome: ChildProcessWithoutNullStreams) {
  const deadline = Date.now() + 10000
  let exited = false
  chrome.once('exit', () => {
    exited = true
  })
  while (Date.now() < deadline) {
    if (exited) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return true
    } catch {}
    await wait(100)
  }
  return false
}

async function waitForPage(port: number, pageUrl: string) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    const pages: any[] = await response.json()
    const page = pages.find((candidate) => candidate.url === pageUrl)
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    await wait(100)
  }
  throw new Error('Timed out waiting for dashboard smoke page')
}

class CdpSession {
  url: string
  id = 0
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  socket: WebSocket | null = null

  constructor(url: string) {
    this.url = url
  }

  connect() {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      this.socket = new WebSocket(this.url)
      this.socket.addEventListener('open', () => resolveConnect())
      this.socket.addEventListener('error', rejectConnect)
      this.socket.addEventListener('close', () => {
        rejectPending(this.pending, new Error('Chrome DevTools socket closed'))
      })
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (!message.id) return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      })
    })
  }

  send(method: string, params: Record<string, any> = {}) {
    const id = ++this.id
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend })
      this.socket?.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    rejectPending(this.pending, new Error('Chrome DevTools session closed'))
    this.socket?.close()
  }
}

async function evaluateWithNavigationRetry(session: CdpSession, params: Record<string, any>) {
  const deadline = Date.now() + 10000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await session.send('Runtime.evaluate', params)
    } catch (error: any) {
      lastError = error
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) {
        throw error
      }
      await wait(100)
    }
  }
  throw lastError
}

async function measureDashboard(session: CdpSession, width: number) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const done = () => {
        const cards = Array.from(document.querySelectorAll('.domain-block'))
        const rects = cards.map((card) => card.getBoundingClientRect()).filter((rect) => rect.width > 0)
        const lefts = Array.from(new Set(rects.map((rect) => Math.round(rect.left))))
        resolve({
          cardCount: rects.length,
          columns: lefts.length,
          firstWidth: Math.round(rects[0]?.width || 0),
          rootHtmlLength: document.getElementById('appRoot')?.innerHTML.length || 0,
          errors: window.__tabOutSmokeErrors || []
        })
      }
      const start = Date.now()
      const wait = () => {
        if (document.querySelectorAll('.domain-block').length >= 12) {
          requestAnimationFrame(() => setTimeout(done, 700))
        } else if (Date.now() - start > 5000) {
          done()
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

test('dashboard cards repack when the viewport resizes', async (t) => {
  if (!RUN_BROWSER_SMOKE) {
    t.skip('set RUN_BROWSER_SMOKE=1 to launch Chrome for the resize smoke test')
    return
  }

  if (typeof WebSocket !== 'function') {
    t.skip('global WebSocket is unavailable for Chrome DevTools Protocol')
    return
  }

  const chromePath = findChrome()
  if (!chromePath) {
    t.skip('Chrome is unavailable for browser resize smoke test')
    return
  }

  const { server, origin } = await serveRepo()
  const userDataDir = mkdtempSync(join(tmpdir(), 'tab-out-chrome-'))
  const pageUrl = `${origin}/tests/fixtures/dashboard-resize.html`
  const port = await freePort()
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    pageUrl
  ])

  let session: CdpSession | null = null
  t.after(async () => {
    await stopChrome(chrome, session)
    server.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  if (!(await waitForDevtools(port, chrome))) {
    t.skip('Chrome did not start with a reachable DevTools endpoint')
    return
  }
  const wsUrl = await waitForPage(port, pageUrl)
  session = new CdpSession(wsUrl)
  await session.connect()

  const wide = await measureDashboard(session, 1420)
  const narrow = await measureDashboard(session, 760)

  assert.ok(wide.cardCount >= 12, `dashboard should render enough cards for a column smoke test: ${JSON.stringify(wide)}`)
  assert.ok(wide.columns > narrow.columns, `expected columns to shrink after resize, got ${wide.columns} -> ${narrow.columns}`)
  assert.notEqual(wide.firstWidth, narrow.firstWidth, 'card width should respond to viewport resize')
})

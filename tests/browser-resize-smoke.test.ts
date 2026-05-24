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

async function measureHorizontalScrollLock(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const scrollRegion = document.querySelector('.scroll-region')
        const rect = scrollRegion?.getBoundingClientRect()
        if (scrollRegion && rect && rect.width > 0 && rect.height > 0) {
          const probe = document.createElement('div')
          probe.dataset.scrollLockProbe = 'true'
          probe.style.cssText = 'display:block;width:200vw;height:1px;pointer-events:none;'
          scrollRegion.append(probe)
          scrollRegion.scrollTo(0, 0)
          requestAnimationFrame(() => {
            const styles = window.getComputedStyle(scrollRegion)
            resolve({
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + Math.min(Math.max(rect.height / 2, 48), rect.height - 8)),
              initialScrollLeft: scrollRegion.scrollLeft,
              scrollWidth: scrollRegion.scrollWidth,
              clientWidth: scrollRegion.clientWidth,
              overflowX: styles.overflowX,
              overscrollBehaviorX: styles.overscrollBehaviorX
            })
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a scroll region for horizontal scroll lock smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: target.x,
    y: target.y,
    deltaX: 220,
    deltaY: 0
  })
  await wait(160)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const scrollRegion = document.querySelector('.scroll-region')
      const probe = scrollRegion?.querySelector('[data-scroll-lock-probe="true"]')
      const result = {
        scrollLeft: scrollRegion?.scrollLeft ?? null,
        scrollWidth: scrollRegion?.scrollWidth ?? 0,
        clientWidth: scrollRegion?.clientWidth ?? 0
      }
      probe?.remove()
      return result
    })()`
  }).then((result: any) => result.result.value)

  return { ...target, afterScrollLeft: after.scrollLeft, afterScrollWidth: after.scrollWidth, afterClientWidth: after.clientWidth }
}

async function waitForTooltipRect(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const tooltip = document.querySelector('[data-slot="tooltip-content"]')
        const rect = tooltip?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          const tooltipText = tooltip.querySelector('.chip-text')
          const textRect = tooltipText?.getBoundingClientRect()
          const styles = window.getComputedStyle(tooltip)
          const outlineWidth = Number.parseFloat(styles.outlineWidth) || 0
          resolve({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            visualLeft: Math.round(rect.left - outlineWidth),
            visualRight: Math.round(rect.right + outlineWidth),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            textLeft: textRect ? Math.round(textRect.left * 100) / 100 : null,
            textTop: textRect ? Math.round(textRect.top * 100) / 100 : null,
            text: tooltip.textContent || '',
            outlineWidth,
            side: tooltip.getAttribute('data-side'),
            align: tooltip.getAttribute('data-align'),
            topLeftRadius: styles.borderTopLeftRadius,
            topRightRadius: styles.borderTopRightRadius,
            transitionDuration: styles.transitionDuration,
            transitionProperty: styles.transitionProperty,
            svgCount: tooltip.querySelectorAll('svg').length
          })
        } else if (Date.now() - start > 2000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function waitForTooltipContaining(session: CdpSession, text: string, timeoutMs = 2000) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const tooltips = Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
          .map((tooltip) => {
            const rect = tooltip.getBoundingClientRect()
            return {
              text: tooltip.textContent || '',
              width: rect.width,
              height: rect.height,
              ending: tooltip.hasAttribute('data-ending-style')
            }
          })
          .filter((tooltip) => tooltip.width > 0 && tooltip.height > 0 && !tooltip.ending)
        const found = tooltips.some((tooltip) => tooltip.text.includes(${JSON.stringify(text)}))
        if (found || Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve({ found, tooltips })
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function getVisibleTooltipTexts(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .filter((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
      })
      .map((tooltip) => tooltip.textContent || '')`
  }).then((result: any) => result.result.value)
}

async function measureTooltipFreeze(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.chip-text-truncated'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          const startX = Math.round(rect.left + Math.min(24, rect.width / 2))
          const y = Math.round(rect.top + rect.height / 2)
          resolve({
            startX,
            moveX: Math.round(Math.min(rect.right - 8, startX + 80)),
            textLeft: Math.round(rect.left),
            textLeftExact: Math.round(rect.left * 100) / 100,
            textRight: Math.round(rect.right),
            textTop: Math.round(rect.top),
            textTopExact: Math.round(rect.top * 100) / 100,
            y
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for tooltip smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.moveX,
    y: target.y
  })
  await wait(150)
  const second = await waitForTooltipRect(session)

  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollBy(0, 160)`
  })
  await wait(220)
  const afterScrollTooltipCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('[data-slot="tooltip-content"]').length`
  }).then((result: any) => result.result.value)

  return { target, first, second, afterScrollTooltipCount, closing: null }
}

async function measureTooltipTextPaddingHitArea(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const hitArea = Array.from(document.querySelectorAll('.chip-text-tooltip-hit-area'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const chipText = hitArea?.querySelector('.chip-text-truncated')
        const hitRect = hitArea?.getBoundingClientRect()
        const textRect = chipText?.getBoundingClientRect()
        if (
          hitRect &&
          textRect &&
          hitRect.width > 120 &&
          textRect.width > 120 &&
          hitRect.top < textRect.top &&
          hitRect.bottom > textRect.bottom
        ) {
          const topGap = textRect.top - hitRect.top
          const bottomGap = hitRect.bottom - textRect.bottom
          resolve({
            x: Math.round(textRect.left + Math.min(24, textRect.width / 2)),
            aboveY: Math.round(textRect.top - Math.max(1, topGap / 2)),
            belowY: Math.round(textRect.bottom + Math.max(1, bottomGap / 2)),
            hitTop: Math.round(hitRect.top),
            hitBottom: Math.round(hitRect.bottom),
            textLeft: Math.round(textRect.left),
            textLeftExact: Math.round(textRect.left * 100) / 100,
            textTop: Math.round(textRect.top),
            textTopExact: Math.round(textRect.top * 100) / 100,
            textBottom: Math.round(textRect.bottom)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip tooltip hit area for padding hover smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY
  })
  await wait(650)
  const above = await waitForTooltipRect(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.belowY
  })
  await wait(650)
  const below = await waitForTooltipRect(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  return { target, above, below }
}

async function measureTooltipAfterActiveStateChanges(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })

  async function setActiveTab(tabId: number, windowId = 1) {
    await evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      expression: `window.__tabOutSmokeSetActiveTab?.(${tabId}, ${windowId})`
    })
    await evaluateWithNavigationRetry(session, {
      expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
    })
    await wait(250)
  }

  async function findTarget() {
    return evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const start = Date.now()
        const wait = () => {
          const chip = Array.from(document.querySelectorAll('.page-chip'))
            .find((candidate) =>
              candidate.textContent?.includes('Example 2 with enough tooltip text')
            )
          const chipText = chip?.querySelector('.chip-text-truncated')
          const rect = chipText?.getBoundingClientRect()
          if (chip && rect && rect.width > 120 && rect.height > 8) {
            resolve({
              activeFrame: !!chip.querySelector('.active-chip-frame'),
              currentActive: chip.classList.contains('current-active-chip'),
              x: Math.round(rect.left + Math.min(24, rect.width / 2)),
              y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
              textLeftExact: Math.round(rect.left * 100) / 100,
              textTopExact: Math.round(rect.top * 100) / 100
            })
          } else if (Date.now() - start > 5000) {
            resolve(null)
          } else {
            setTimeout(wait, 50)
          }
        }
        wait()
      })`
    }).then((result: any) => result.result.value)
  }

  async function hoverTarget(target: { x: number; y: number }) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x,
      y: target.y
    })
    await wait(650)
    const tooltip = await waitForTooltipRect(session)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8
    })
    await wait(250)
    return tooltip
  }

  await setActiveTab(2, 2)
  const activeTarget = await findTarget()
  assert.ok(activeTarget, 'expected active-state tooltip target')
  const activeTooltip = await hoverTarget(activeTarget)

  await setActiveTab(1)
  const inactiveTarget = await findTarget()
  assert.ok(inactiveTarget, 'expected inactive-state tooltip target')
  const inactiveTooltip = await hoverTarget(inactiveTarget)

  return { activeTarget, activeTooltip, inactiveTarget, inactiveTooltip }
}

async function measureSuppressionMarkerTooltipLine(session: CdpSession, label: string) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10))
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a title-suppression page chip for ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)

  const result = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"]')
      const tooltipText = tooltip?.querySelector('.chip-text')
      const marker = tooltip?.querySelector('.chip-title-suppression-marker')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const textRect = tooltipText?.getBoundingClientRect()
      const markerRect = marker?.getBoundingClientRect()
      if (!tooltip || !tooltipText || !marker || !tooltipRect || !textRect || !markerRect) return null

      const textStyles = window.getComputedStyle(tooltipText)
      const markerStyles = window.getComputedStyle(marker)
      const lineHeight = Number.parseFloat(textStyles.lineHeight) || 16.25
      const markerLine = Math.round((markerRect.top - textRect.top) / lineHeight) + 1
      const lineTop = textRect.top + (markerLine - 1) * lineHeight
      const markerCenter = markerRect.top + markerRect.height / 2
      const lineCenter = lineTop + lineHeight / 2

      return {
        label: ${JSON.stringify(label)},
        text: tooltip.textContent || '',
        markerLine,
        markerCenterDelta: Math.round((markerCenter - lineCenter) * 100) / 100,
        markerHeight: Math.round(markerRect.height * 100) / 100,
        markerLineHeight: markerStyles.lineHeight,
        markerVerticalAlign: markerStyles.verticalAlign,
        textLineHeight: Math.round(lineHeight * 100) / 100,
        tooltipRight: Math.round(tooltipRect.right),
        viewportRight: window.innerWidth,
        tooltipTop: Math.round(tooltipRect.top),
        textTop: Math.round(textRect.top),
        markerTop: Math.round(markerRect.top)
      }
    })()`
  }).then((measurement: any) => measurement.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(240)

  return { target, result }
}

async function measureSuppressionMarkerChipLine(session: CdpSession, label: string) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const result = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        const marker = chipText?.querySelector('.chip-title-suppression-marker')
        const glyph = marker?.querySelector('.chip-title-suppression-glyph')
        const textRect = chipText?.getBoundingClientRect()
        const markerRect = marker?.getBoundingClientRect()
        const glyphRect = glyph?.getBoundingClientRect()
        if (chipText && marker && glyph && textRect && markerRect && glyphRect && textRect.width > 120 && textRect.height > 8) {
          const textStyles = window.getComputedStyle(chipText)
          const markerStyles = window.getComputedStyle(marker)
          const lineHeight = Number.parseFloat(textStyles.lineHeight) || 16.25
          const markerLine = Math.round((markerRect.top - textRect.top) / lineHeight) + 1
          const lineTop = textRect.top + (markerLine - 1) * lineHeight
          const markerCenter = markerRect.top + markerRect.height / 2
          const glyphCenter = glyphRect.top + glyphRect.height / 2
          const lineCenter = lineTop + lineHeight / 2
          resolve({
            label: ${JSON.stringify(label)},
            text: chipText.textContent || '',
            markerLine,
            markerCenterDelta: Math.round((markerCenter - lineCenter) * 100) / 100,
            glyphCenterDelta: Math.round((glyphCenter - markerCenter) * 100) / 100,
            markerHeight: Math.round(markerRect.height * 100) / 100,
            glyphHeight: Math.round(glyphRect.height * 100) / 100,
            markerLineHeight: markerStyles.lineHeight,
            markerVerticalAlign: markerStyles.verticalAlign,
            textLineHeight: Math.round(lineHeight * 100) / 100,
            textTop: Math.round(textRect.top),
            markerTop: Math.round(markerRect.top)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((measurement: any) => measurement.result.value)

  return { result }
}

async function measurePageChipTooltipLineCount(
  session: CdpSession,
  label: string,
  options: { forcedTextWidth?: number; forcedMaxLines?: number; viewportWidth?: number } = {}
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewportWidth || 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        if (${JSON.stringify(!!options.forcedTextWidth)} && chipText instanceof HTMLElement) {
          chipText.style.flex = '0 0 ${options.forcedTextWidth || 0}px'
          chipText.style.maxWidth = '${options.forcedTextWidth || 0}px'
        }
        if (${JSON.stringify(!!options.forcedMaxLines)} && chipText instanceof HTMLElement) {
          chipText.style.maxHeight = 'calc(${options.forcedMaxLines || 1}lh)'
        }
        const rect = chipText?.getBoundingClientRect()
        if (chipText && rect && rect.width > 80 && rect.height > 8) {
          const styles = window.getComputedStyle(chipText)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          const chipLineCount = Math.max(1, Math.round(rect.height / lineHeight))
          const collectLineTexts = (root, limit) => {
            const rootRect = root.getBoundingClientRect()
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
              }
            })
            const range = document.createRange()
            const lines = Array.from({ length: limit }, () => '')
            while (true) {
              const node = walker.nextNode()
              if (!node) break
              const text = node.textContent || ''
              for (let offset = 0; offset < text.length; offset += 1) {
                range.setStart(node, offset)
                range.setEnd(node, offset + 1)
                const rects = Array.from(range.getClientRects())
                const paintedRects = rects.filter((candidate) => candidate.width > 0 || candidate.height > 0)
                const charRect = paintedRects[paintedRects.length - 1]
                if (!charRect) continue
                const lineIndex = Math.max(0, Math.round((charRect.top - rootRect.top) / lineHeight))
                if (lineIndex >= limit) return lines
                lines[lineIndex] += text[offset]
              }
            }
            return lines
          }
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
            chipText: chipText.textContent || '',
            chipLineTexts: collectLineTexts(chipText, chipLineCount),
            chipLeft: Math.round(rect.left),
            chipLeftExact: Math.round(rect.left * 100) / 100,
            chipTop: Math.round(rect.top),
            chipTopExact: Math.round(rect.top * 100) / 100,
            chipWidth: Math.round(rect.width),
            chipHeight: Math.round(rect.height),
            chipLineHeight: Math.round(lineHeight * 100) / 100,
            chipLineCount
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a page chip for tooltip line-count check: ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)

  const tooltip = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"]')
      const tooltipText = tooltip?.querySelector('.chip-text')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const textRect = tooltipText?.getBoundingClientRect()
      if (!tooltip || !tooltipText || !tooltipRect || !textRect) return null
      const styles = window.getComputedStyle(tooltipText)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
      const lineNodes = Array.from(tooltipText.querySelectorAll('.page-chip-tooltip-line'))
      const tooltipLineTexts = lineNodes.length > 0
        ? lineNodes.map((node) => node.textContent || '')
        : [tooltipText.textContent || '']
      const tooltipLineOverflows = lineNodes.map((node) => {
        const nodeRect = node.getBoundingClientRect()
        const range = document.createRange()
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode(textNode) {
            return textNode.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
          }
        })
        try {
          if (node.scrollWidth - node.clientWidth > 1) return true
          while (true) {
            const textNode = walker.nextNode()
            if (!textNode) break
            range.selectNodeContents(textNode)
            for (const rect of range.getClientRects()) {
              if (rect.width > 0 && rect.right - nodeRect.right > 1) return true
            }
          }
          return false
        } finally {
          range.detach()
        }
      })
      return {
        text: tooltip.textContent || '',
        tooltipLineTexts,
        tooltipLineOverflows,
        left: Math.round(tooltipRect.left),
        right: Math.round(tooltipRect.right),
        top: Math.round(tooltipRect.top),
        width: Math.round(tooltipRect.width),
        textWidth: Math.round(textRect.width),
        textHeight: Math.round(textRect.height),
        textLeft: Math.round(textRect.left * 100) / 100,
        textTop: Math.round(textRect.top * 100) / 100,
        textLineHeight: Math.round(lineHeight * 100) / 100,
        tooltipLineCount: Math.max(1, Math.round(textRect.height / lineHeight)),
        viewportRight: window.innerWidth
      }
    })()`
  }).then((measurement: any) => measurement.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(240)

  return { target, tooltip }
}

async function measureFoldedPageChipTooltipTitleLineCount(
  session: CdpSession,
  label: string,
  options: { forcedTextWidth?: number } = {}
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-folded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
        const chipText = chip?.querySelector('.chip-text')
        if (${JSON.stringify(!!options.forcedTextWidth)} && chipText instanceof HTMLElement) {
          chipText.style.flex = '0 0 ${options.forcedTextWidth || 0}px'
          chipText.style.maxWidth = '${options.forcedTextWidth || 0}px'
        }
        const titleRow = chip?.querySelector('.chip-title-row')
        const envRow = chip?.querySelector('.chip-env-row')
        const chipTextRect = chipText?.getBoundingClientRect()
        const titleRect = titleRow?.getBoundingClientRect()
        const envRect = envRow?.getBoundingClientRect()
        if (chipText && titleRow && envRow && chipTextRect && titleRect && envRect && chipTextRect.width > 80 && chipTextRect.height > 8) {
          const styles = window.getComputedStyle(titleRow)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          resolve({
            x: Math.round(chipTextRect.left + Math.min(24, chipTextRect.width / 2)),
            y: Math.round(chipTextRect.top + Math.min(titleRect.height / 2, 10)),
            titleText: titleRow.textContent || '',
            envText: envRow.textContent || '',
            titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
            titleWidth: Math.round(titleRect.width),
            chipTextWidth: Math.round(chipTextRect.width)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a folded page chip for tooltip check: ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)

  const tooltip = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"]')
      const tooltipText = tooltip?.querySelector('.chip-text')
      const titleRow = tooltip?.querySelector('.chip-title-row')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const titleRect = titleRow?.getBoundingClientRect()
      if (!tooltip || !tooltipText || !titleRow || !tooltipRect || !titleRect) return null
      const styles = window.getComputedStyle(titleRow)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
      return {
        text: tooltip.textContent || '',
        titleText: titleRow.textContent || '',
        envCount: tooltip.querySelectorAll('.chip-env').length,
        titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
        titleWidth: Math.round(titleRect.width),
        textWidth: Math.round(tooltipText.getBoundingClientRect().width),
        width: Math.round(tooltipRect.width),
        right: Math.round(tooltipRect.right),
        viewportRight: window.innerWidth
      }
    })()`
  }).then((measurement: any) => measurement.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(240)

  return { target, tooltip }
}

async function measureFoldedEnvHoverTooltips(
  session: CdpSession,
  label: string
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(650)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-folded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
        const envButton = chip?.querySelector('.chip-env')
        const rect = envButton?.getBoundingClientRect()
        if (envButton && rect && rect.width > 10 && rect.height > 10) {
          resolve({
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            text: envButton.textContent || ''
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a folded env button for tooltip check: ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)

  const tooltipTexts = await getVisibleTooltipTexts(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(240)

  return { target, tooltipTexts }
}

async function measureInteractiveTooltipClickReturnFocus(
  session: CdpSession,
  selector: string,
  marker: string,
  targetLabel: string,
  requiredDescendantSelector: string
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const trigger = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .find((candidate) => {
            const hasRequiredDescendant =
              candidate.matches(${JSON.stringify(requiredDescendantSelector)}) ||
              !!candidate.querySelector(${JSON.stringify(requiredDescendantSelector)})
            return candidate.textContent?.includes(${JSON.stringify(marker)}) && hasRequiredDescendant
          })
        const rect = trigger?.getBoundingClientRect()
        if (trigger && rect && rect.width > 120 && rect.height > 8) {
          const focusTarget = trigger.closest('.page-chip') || trigger
          focusTarget.setAttribute('data-smoke-click-return-target', ${JSON.stringify(targetLabel)})
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a ${targetLabel} tooltip trigger for click-return smoke test`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipContaining(session, marker)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await wait(120)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(240)

  const afterReturnFocus = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const trigger = document.querySelector(${JSON.stringify(`[data-smoke-click-return-target="${targetLabel}"]`)})
      if (!(trigger instanceof HTMLElement)) return null
      trigger.blur()
      window.dispatchEvent(new Event('blur'))
      trigger.focus()
      window.dispatchEvent(new Event('focus'))
      return {
        active: document.activeElement === trigger,
        focusVisible: trigger.matches(':focus-visible')
      }
    })()`
  }).then((result: any) => result.result.value)
  await wait(240)

  return {
    target,
    first,
    afterReturnFocus,
    afterReturnTooltips: await getVisibleTooltipTexts(session)
  }
}

async function measureTooltipPopupHover(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.chip-text-truncated'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            startX: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for popup hover smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  assert.ok(first, `tooltip should open before popup hover check: ${JSON.stringify({ target, first })}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(first.left + first.width / 2),
    y: Math.round((target.y + first.top) / 2)
  })
  await wait(50)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  })
  await wait(220)
  const whileHovered = await waitForTooltipRect(session)

  for (let index = 0; index < 8; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8 + index * 16,
      y: 8 + index * 5
    })
    await wait(80)
  }
  const afterLeaveTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .map((tooltip) => tooltip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, whileHovered, afterLeaveTooltips }
}

async function measureTooltipPopupClickFocus(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.scroll-region')?.scrollTo(0, 0)
      window.__tabOutSmokeFocusUpdates = []
      const originalTabsUpdate = chrome.tabs.update
      const originalWindowsUpdate = chrome.windows.update
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return originalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return originalWindowsUpdate(...args)
      }
    })()`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.chip-text-truncated'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for popup click smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)
  assert.ok(first, `tooltip should open before popup click check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  const popupStyle = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"].page-chip-tooltip')
      if (!tooltip) return null
      const styles = window.getComputedStyle(tooltip)
      return {
        cursor: styles.cursor,
        userSelect: styles.userSelect
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: popupPoint.x,
    y: popupPoint.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: popupPoint.x,
    y: popupPoint.y
  })
  await wait(220)

  const updates = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `window.__tabOutSmokeFocusUpdates || []`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, popupStyle, updates }
}

async function measurePageChipContextMenuSave(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.scroll-region')?.scrollTo(0, 0)
      window.__tabOutSmokeSavedStore = {}
      window.__tabOutSmokeSavedSets = []
      window.__tabOutSmokeCopiedText = null
      window.__tabOutSmokeFocusUpdates = []
      window.__tabOutSmokeOriginalTabsUpdate = chrome.tabs.update
      window.__tabOutSmokeOriginalWindowsUpdate = chrome.windows.update
      chrome.storage.local.get = async () => window.__tabOutSmokeSavedStore
      chrome.storage.local.set = async (next) => {
        window.__tabOutSmokeSavedStore = { ...window.__tabOutSmokeSavedStore, ...next }
        window.__tabOutSmokeSavedSets.push(next)
      }
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return window.__tabOutSmokeOriginalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return window.__tabOutSmokeOriginalWindowsUpdate(...args)
      }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__tabOutSmokeCopiedText = text
          }
        }
      })
    })()`
  })
  await wait(250)

  async function findPageChipTarget(label: string, xOffset = 96) {
    return evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const start = Date.now()
        const wait = () => {
          const chip = Array.from(document.querySelectorAll('.page-chip'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
          const rect = chip?.getBoundingClientRect()
          if (rect && rect.width > 120 && rect.height > 8) {
            resolve({
              label: ${JSON.stringify(label)},
              x: Math.round(rect.left + Math.min(${xOffset}, rect.width - 8)),
              y: Math.round(rect.top + rect.height / 2)
            })
          } else if (Date.now() - start > 5000) {
            resolve(null)
          } else {
            setTimeout(wait, 50)
          }
        }
        wait()
      })`
    }).then((result: any) => result.result.value)
  }

  const target = await findPageChipTarget('Short title')
  const replacementTarget = await findPageChipTarget('Example 2 with enough tooltip text', 140)
  const historyMatchTarget = await findPageChipTarget('Example 3 with enough tooltip text', 16)

  assert.ok(target, 'expected a live page chip for context menu save smoke test')
  assert.ok(replacementTarget, 'expected a second live page chip for context menu replacement smoke test')
  assert.ok(historyMatchTarget, 'expected a live page chip with a matching history entry for context menu hover smoke test')

  async function openContextMenuAt(menuTarget: { x: number; y: number }) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: menuTarget.x,
      y: menuTarget.y
    })
    await wait(80)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'right',
      buttons: 2,
      clickCount: 1,
      x: menuTarget.x,
      y: menuTarget.y
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'right',
      buttons: 0,
      clickCount: 1,
      x: menuTarget.x,
      y: menuTarget.y
    })
    await wait(220)
  }

  async function readContextMenuState() {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const visibleMenus = Array.from(document.querySelectorAll('[data-slot="context-menu-content"]'))
          .filter((menu) => !menu.hidden && menu.getClientRects().length > 0 && window.getComputedStyle(menu).visibility !== 'hidden')
        return {
          visibleMenuCount: visibleMenus.length,
          itemTexts: visibleMenus.flatMap((menu) =>
            Array.from(menu.querySelectorAll('[data-slot="context-menu-item"]'))
              .map((item) => item.textContent?.trim() || '')
          ),
          backdropCount: document.querySelectorAll('[data-slot="context-menu-backdrop"]:not([hidden])').length
        }
      })()`
    }).then((result: any) => result.result.value)
  }

  async function readPageChipVisualState(menuTarget: { label: string }) {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(menuTarget.label)}))
        if (!(chip instanceof HTMLElement)) return null
        const styles = window.getComputedStyle(chip)
        const closeButton = chip.querySelector('.chip-close-favicon')
        const faviconContent = chip.querySelector('.chip-favicon-content')
        const dupeBadge = chip.querySelector('.chip-dupe-badge')
        const readPart = (part) => {
          if (!(part instanceof HTMLElement)) return null
          const partStyles = window.getComputedStyle(part)
          return {
            opacity: partStyles.opacity,
            pointerEvents: partStyles.pointerEvents
          }
        }
        return {
          backgroundColor: styles.backgroundColor,
          className: chip.className,
          contextMenuOpen: chip.classList.contains('page-chip-context-menu-open'),
          tooltipOpen: chip.classList.contains('page-chip-tooltip-open'),
          closeButton: readPart(closeButton),
          dupeBadge: readPart(dupeBadge),
          faviconContent: readPart(faviconContent),
          hover: chip.matches(':hover'),
          urlPreview: document.querySelector('.url-preview span')?.textContent || ''
        }
      })()`
    }).then((result: any) => result.result.value)
  }

  async function dismissContextMenuWithPointer() {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: 8,
      y: 8
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      x: 8,
      y: 8
    })
    await wait(220)
  }

  async function clickMenuItem(label: string) {
    await openContextMenuAt(target)

    const item = await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const item = Array.from(document.querySelectorAll('[data-slot="context-menu-item"]'))
          .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)})
        const rect = item?.getBoundingClientRect()
        if (!rect) return null
        return {
          text: item.textContent?.trim() || '',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        }
      })()`
    }).then((result: any) => result.result.value)

    assert.ok(item, `expected ${label} context menu item after right-click: ${JSON.stringify({ target })}`)

    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: item.x,
      y: item.y
    })
    await wait(80)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: item.x,
      y: item.y
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      x: item.x,
      y: item.y
    })
    await wait(220)

    return item
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(180)
  const restingChipState = await readPageChipVisualState(target)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(180)
  const hoverChipState = await readPageChipVisualState(target)
  await openContextMenuAt(target)
  const contextMenuOpenChipState = await readPageChipVisualState(target)
  const firstOpenState = await readContextMenuState()
  assert.ok(restingChipState, `expected chip visual state before context menu: ${JSON.stringify({ target, restingChipState })}`)
  assert.ok(hoverChipState, `expected chip hover visual state before context menu: ${JSON.stringify({ target, hoverChipState })}`)
  assert.ok(contextMenuOpenChipState, `expected chip visual state while context menu is open: ${JSON.stringify({ target, contextMenuOpenChipState })}`)
  assert.notEqual(hoverChipState.backgroundColor, restingChipState.backgroundColor, `hover should visibly change the page chip background before the context menu opens: ${JSON.stringify({ restingChipState, hoverChipState })}`)
  assert.equal(hoverChipState.closeButton?.opacity, '1', `hover should show the favicon-slot close button before the context menu opens: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverChipState.closeButton?.pointerEvents, 'auto', `hover should make the favicon-slot close button interactive before the context menu opens: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverChipState.faviconContent?.opacity, '0', `hover should hide the favicon beneath the close button before the context menu opens: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(contextMenuOpenChipState.contextMenuOpen, true, `context menu trigger should carry an explicit menu-open class: ${JSON.stringify({ contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.backgroundColor, hoverChipState.backgroundColor, `page chip should keep its hover-like background while its context menu is open: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.closeButton?.opacity, hoverChipState.closeButton?.opacity, `page chip should keep its favicon-slot close button visible while its context menu is open: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.closeButton?.pointerEvents, hoverChipState.closeButton?.pointerEvents, `page chip should keep the same close-button affordance while its context menu is open: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.faviconContent?.opacity, hoverChipState.faviconContent?.opacity, `page chip should keep its favicon hidden while its context menu is open: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  await openContextMenuAt(replacementTarget)
  const replacementState = await readContextMenuState()
  assert.equal(firstOpenState.visibleMenuCount, 1, `first right-click should open one visible context menu: ${JSON.stringify(firstOpenState)}`)
  assert.ok(firstOpenState.backdropCount > 0, `an open context menu should render a backdrop to consume outside clicks: ${JSON.stringify(firstOpenState)}`)
  assert.ok(replacementState.visibleMenuCount <= 1, `right-clicking a second chip should not stack context menus: ${JSON.stringify(replacementState)}`)
  await dismissContextMenuWithPointer()

  const freshHistoryMatchTarget = await findPageChipTarget('Example 3 with enough tooltip text', 16)
  assert.ok(freshHistoryMatchTarget, 'expected the matching-history page chip target to remain visible after context-menu replacement smoke')
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: freshHistoryMatchTarget.x,
    y: freshHistoryMatchTarget.y
  })
  await wait(180)
  const hoveredHistoryChipState = await readPageChipVisualState(freshHistoryMatchTarget)
  await openContextMenuAt(freshHistoryMatchTarget)
  const contextMenuHistoryChipState = await readPageChipVisualState(freshHistoryMatchTarget)
  assert.equal(hoveredHistoryChipState?.urlPreview, 'https://tab-out-smoke-03.com/docs/3', `hovering the matching-history page chip should set the shared hover URL before the context menu opens: ${JSON.stringify({ hoveredHistoryChipState, freshHistoryMatchTarget })}`)
  assert.equal(contextMenuHistoryChipState?.contextMenuOpen, true, `matching-history page chip should carry the context-menu-open class: ${JSON.stringify({ contextMenuHistoryChipState })}`)
  assert.equal(contextMenuHistoryChipState?.urlPreview, hoveredHistoryChipState?.urlPreview, `opening the page chip context menu should keep the shared hover URL active for cross-surface matching: ${JSON.stringify({ hoveredHistoryChipState, contextMenuHistoryChipState })}`)
  await dismissContextMenuWithPointer()

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: replacementTarget.x,
    y: replacementTarget.y
  })
  await wait(650)
  const contextTooltip = await waitForTooltipRect(session)
  assert.ok(contextTooltip, `tooltip should open before context-menu shield check: ${JSON.stringify({ replacementTarget, contextTooltip })}`)
  const tooltipOpenChipState = await readPageChipVisualState(replacementTarget)
  assert.equal(tooltipOpenChipState?.tooltipOpen, true, `page chip should keep an explicit tooltip-open class while its tooltip is visible: ${JSON.stringify({ tooltipOpenChipState })}`)
  assert.equal(tooltipOpenChipState?.backgroundColor, hoverChipState.backgroundColor, `page chip should keep the same hover background after its tooltip appears: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  assert.equal(tooltipOpenChipState?.closeButton?.opacity, hoverChipState.closeButton?.opacity, `page chip should keep the same hover affordance after its tooltip appears: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  assert.equal(tooltipOpenChipState?.faviconContent?.opacity, hoverChipState.faviconContent?.opacity, `page chip should keep the favicon hidden after its tooltip appears: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  await openContextMenuAt(replacementTarget)
  const contextTooltipAfterMenu = await waitForTooltipContaining(session, 'Example 2 with enough tooltip text', 500)
  assert.ok(contextTooltipAfterMenu.found, `right-clicking to open a page chip context menu should not hide a visible tooltip: ${JSON.stringify({ contextTooltip, contextTooltipAfterMenu })}`)
  const tooltipShieldPoint = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      document.querySelector('[data-smoke-tooltip-shield]')?.remove()
      const syntheticTooltip = document.createElement('div')
      syntheticTooltip.dataset.slot = 'tooltip-content'
      syntheticTooltip.dataset.smokeTooltipShield = 'true'
      syntheticTooltip.textContent = 'Synthetic tooltip shield target'
      syntheticTooltip.style.cssText = [
        'position:fixed',
        'left:24px',
        'top:24px',
        'width:220px',
        'height:32px',
        'z-index:50',
        'pointer-events:auto',
        'background:canvas',
        'color:canvastext'
      ].join(';')
      syntheticTooltip.addEventListener('click', () => {
        chrome.tabs.update(1, { active: true })
      })
      document.body.append(syntheticTooltip)
      const rect = syntheticTooltip.getBoundingClientRect()
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      }
    })()`
  }).then((result: any) => result.result.value)
  const shieldBeforeClick = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      window.__tabOutSmokeFocusUpdates = []
      const target = document.elementFromPoint(${tooltipShieldPoint.x}, ${tooltipShieldPoint.y})
      const owner = target?.closest?.('[data-slot]')
      return {
        point: ${JSON.stringify(tooltipShieldPoint)},
        topSlot: owner?.getAttribute('data-slot') || '',
        topText: owner?.textContent?.trim() || '',
        menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])'),
        tooltipOpen: !!document.querySelector('[data-slot="tooltip-content"]:not([hidden])')
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y
  })
  await wait(220)
  const shieldAfterClick = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const focusUpdates = window.__tabOutSmokeFocusUpdates || []
      chrome.tabs.update = window.__tabOutSmokeOriginalTabsUpdate
      chrome.windows.update = window.__tabOutSmokeOriginalWindowsUpdate
      document.querySelector('[data-smoke-tooltip-shield]')?.remove()
      return {
        focusUpdateCount: focusUpdates.length,
        menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])')
      }
    })()`
  }).then((result: any) => result.result.value)
  assert.notEqual(shieldBeforeClick.topSlot, 'tooltip-content', `context menu backdrop should cover visible tooltips: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)
  assert.equal(shieldAfterClick.focusUpdateCount, 0, `clicking where a tooltip is visible while context menu is open should not focus/open the page: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)
  assert.equal(shieldAfterClick.menuOpen, false, `clicking the context menu backdrop over a tooltip should dismiss the menu: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)

  const copyItem = await clickMenuItem('Copy page title text')
  const copyResult = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `({
      copiedText: window.__tabOutSmokeCopiedText,
      menuOpen: !!document.querySelector('[data-slot="context-menu-content"]')
    })`
  }).then((result: any) => result.result.value)

  const saveItem = await clickMenuItem('Save page')

  const saveResult = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const store = window.__tabOutSmokeSavedStore?.tabOutSavedPagesV1
      const pageKeys = store?.pages ? Object.keys(store.pages) : []
      return {
        itemText: ${JSON.stringify('Save page')},
        menuOpen: !!document.querySelector('[data-slot="context-menu-content"]'),
        pageKeys,
        setCount: window.__tabOutSmokeSavedSets?.length || 0
      }
    })()`
  }).then((result: any) => result.result.value)

  await openContextMenuAt(target)
  const sourceButtonTarget = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const button = Array.from(document.querySelectorAll('.source-switch-option'))
        .find((candidate) => candidate.textContent?.trim() === 'Bookmarks')
      const activeBefore = document.querySelector('.source-switch-option[data-active]')?.textContent?.trim() || ''
      const rect = button?.getBoundingClientRect()
      if (!rect) return null
      return {
        activeBefore,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      }
    })()`
  }).then((result: any) => result.result.value)

  assert.ok(sourceButtonTarget, 'expected the Bookmarks source switch button for context menu outside-click smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y
  })
  await wait(450)

  const outsideClickResult = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `({
      activeBefore: ${JSON.stringify(sourceButtonTarget.activeBefore)},
      activeAfter: document.querySelector('.source-switch-option[data-active]')?.textContent?.trim() || '',
      menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])')
    })`
  }).then((result: any) => result.result.value)

  return { target, firstOpenState, replacementState, shieldBeforeClick, shieldAfterClick, copyItem, copyResult, saveItem, saveResult, outsideClickResult }
}

async function measureTooltipPopupWheelScroll(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.chip-text-truncated'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for popup wheel smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  assert.ok(first, `tooltip should open before popup wheel check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y
  })
  await wait(80)

  const beforeScrollTop = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelector('.scroll-region')?.scrollTop ?? 0`
  }).then((result: any) => result.result.value)

  const wheelSteps = []
  for (let index = 0; index < 4; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 36,
      x: popupPoint.x,
      y: popupPoint.y
    })
    await wait(60)
    wheelSteps.push(await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const scrollRegion = document.querySelector('.scroll-region')
        return {
          scrollTop: scrollRegion?.scrollTop ?? 0,
          tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
        }
      })()`
    }).then((result: any) => result.result.value))
  }
  const beforeForwardedWheelTop = wheelSteps.at(-1)?.scrollTop ?? beforeScrollTop
  const forwardedWheelSteps = []
  for (let index = 0; index < 3; index += 1) {
    forwardedWheelSteps.push(await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: ${popupPoint.x},
          clientY: ${popupPoint.y},
          deltaX: 0,
          deltaY: 36
        })
        window.dispatchEvent(event)
        const scrollRegion = document.querySelector('.scroll-region')
        return {
          defaultPrevented: event.defaultPrevented,
          scrollTop: scrollRegion?.scrollTop ?? 0,
          tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
        }
      })()`
    }).then((result: any) => result.result.value))
    await wait(60)
  }
  await wait(620)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const scrollRegion = document.querySelector('.scroll-region')
      return {
        scrollTop: scrollRegion?.scrollTop ?? 0,
        tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(620)

  const afterLeaveTooltipCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('[data-slot="tooltip-content"]').length`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, beforeScrollTop, wheelSteps, beforeForwardedWheelTop, forwardedWheelSteps, after, afterLeaveTooltipCount }
}

async function measureHistoryTooltipPopupWheelScroll(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.history-entry-list')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
          .find((candidate) =>
            candidate.closest('.history-entry-row')?.textContent?.includes('Working set item with enough tooltip text')
          )
        const rect = title?.getBoundingClientRect()
        const list = document.querySelector('.history-entry-list')
        if (rect && list && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2),
            listScrollHeight: list.scrollHeight,
            listClientHeight: list.clientHeight
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a history-panel entry to hover for popup wheel smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  assert.ok(first, `history tooltip should open before popup wheel check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y
  })
  await wait(80)

  const beforeScrollTop = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      return {
        dashboardScrollTop: document.querySelector('.scroll-region')?.scrollTop ?? 0,
        historyScrollTop: document.querySelector('.history-entry-list')?.scrollTop ?? 0
      }
    })()`
  }).then((result: any) => result.result.value)

  for (let index = 0; index < 4; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 18,
      x: popupPoint.x,
      y: popupPoint.y
    })
    await wait(60)
  }
  await wait(620)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const historyList = document.querySelector('.history-entry-list')
      const dashboardScrollRegion = document.querySelector('.scroll-region')
      return {
        dashboardScrollTop: dashboardScrollRegion?.scrollTop ?? 0,
        historyScrollTop: historyList?.scrollTop ?? 0,
        tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(620)

  const afterLeaveTooltipCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('[data-slot="tooltip-content"]').length`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, beforeScrollTop, after, afterLeaveTooltipCount }
}

async function measureTooltipWindowBlurClose(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.chip-text-truncated'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip for tooltip window-blur smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  await evaluateWithNavigationRetry(session, {
    expression: `window.dispatchEvent(new Event('blur'))`
  })
  await wait(240)

  const afterBlurTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .filter((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
      })
      .map((tooltip) => tooltip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, afterBlurTooltips }
}

async function measureTooltipVisibilityChangeClose(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.chip-text-truncated'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip for tooltip visibility-change smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      const stateDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
      const hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
      try {
        Object.defineProperty(Document.prototype, 'visibilityState', {
          configurable: true,
          get: () => 'hidden'
        })
        Object.defineProperty(Document.prototype, 'hidden', {
          configurable: true,
          get: () => true
        })
        document.dispatchEvent(new Event('visibilitychange'))
      } finally {
        if (stateDescriptor) {
          Object.defineProperty(Document.prototype, 'visibilityState', stateDescriptor)
        }
        if (hiddenDescriptor) {
          Object.defineProperty(Document.prototype, 'hidden', hiddenDescriptor)
        }
      }
    })()`
  })
  await wait(240)

  const afterVisibilityChangeTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .filter((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
      })
      .map((tooltip) => tooltip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, afterVisibilityChangeTooltips }
}

async function measureActionTooltipClickClose(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const button = document.querySelector('.domain-pin-btn')
        const rect = button?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          resolve({
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            label: button.getAttribute('aria-label')
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a pin button for tooltip click-close smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await wait(120)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(360)

  const afterLeaveTooltips = await getVisibleTooltipTexts(session)

  const focusedAfterLeave = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.activeElement?.classList.contains('domain-pin-btn') || false`
  }).then((result: any) => result.result.value)

  return { target, first, afterLeaveTooltips, focusedAfterLeave }
}

async function measureMarkerToChipTooltipHandoff(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) =>
            candidate.textContent?.includes('Hover Handoff Title') &&
            candidate.querySelector('.chip-strip-indicator')
          )
        const marker = chip?.querySelector('.chip-strip-indicator')
        const text = chip?.querySelector('.chip-text')
        const markerRect = marker?.getBoundingClientRect()
        const textRect = text?.getBoundingClientRect()
        if (markerRect && textRect && markerRect.width > 0 && textRect.width > 0) {
          resolve({
            markerX: Math.round(markerRect.left + markerRect.width / 2),
            textX: Math.round(Math.min(textRect.right - 8, markerRect.right + 16)),
            y: Math.round(markerRect.top + markerRect.height / 2),
            markerText: marker.textContent || '',
            chipText: chip?.textContent || ''
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a chip with a strip indicator for tooltip handoff smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.markerX,
    y: target.y
  })
  await wait(650)
  const markerTooltip = await waitForTooltipContaining(session, 'dev2')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.textX,
    y: target.y
  })
  const chipTooltip = await waitForTooltipContaining(session, 'Hover Handoff Title')

  return { target, markerTooltip, chipTooltip }
}

async function measureShortChipTooltipAbsence(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes('Short title'))
        const textEl = chip?.querySelector('.chip-text')
        const rect = textEl?.getBoundingClientRect()
        if (rect && textEl && rect.width > 120 && rect.height > 8) {
          resolve({
            startX: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2),
            isTruncated: textEl.classList.contains('chip-text-truncated')
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a short page chip to hover for tooltip absence smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)

  const tooltipCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('[data-slot="tooltip-content"]').length`
  }).then((result: any) => result.result.value)

  return { target, tooltipCount }
}

async function measureTooltipEdgeFlip(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await wait(250)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chips = Array.from(document.querySelectorAll('.page-chip'))
          .filter((chip) => chip.textContent?.includes('viewport-edge'))
          .map((chip) => {
            const textEl = chip.querySelector('.chip-text')
            const rect = textEl?.getBoundingClientRect()
            return { rect }
          })
          .filter(({ rect }) => rect && rect.width > 120 && rect.height > 8)
          .sort((a, b) => b.rect.right - a.rect.right)

        const target = chips[0]
        if (target) {
          resolve({
            startX: Math.round(target.rect.right - 4),
            textLeft: Math.round(target.rect.left),
            textRight: Math.round(target.rect.right),
            y: Math.round(target.rect.top + target.rect.height / 2),
            viewportRight: window.innerWidth
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a right-edge page chip to hover for tooltip smoke test')

  await wait(250)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)
  const first = await waitForTooltipRect(session)

  return { target, first }
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

  const horizontalScroll = await measureHorizontalScrollLock(session)
  assert.equal(horizontalScroll.overflowX, 'hidden', `scroll region should hide horizontal overflow: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.overscrollBehaviorX, 'none', `scroll region should suppress x-axis overscroll: ${JSON.stringify(horizontalScroll)}`)
  assert.ok(horizontalScroll.scrollWidth > horizontalScroll.clientWidth, `smoke probe should create horizontal overflow: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.initialScrollLeft, 0, `scroll region should start at the left edge: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.afterScrollLeft, 0, `horizontal wheel input should not move the scroll region sideways: ${JSON.stringify(horizontalScroll)}`)

  const shortTooltip = await measureShortChipTooltipAbsence(session)
  assert.equal(shortTooltip.target.isTruncated, false, `short chip text should fit for tooltip absence smoke test: ${JSON.stringify(shortTooltip)}`)
  assert.equal(shortTooltip.tooltipCount, 0, `page chip should not show a tooltip when its text fits: ${JSON.stringify(shortTooltip)}`)

  const contextMenuSave = await measurePageChipContextMenuSave(session)
  assert.equal(contextMenuSave.copyItem.text, 'Copy page title text', `right-clicking a live page chip should show the copy-title action: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyResult.copiedText, 'Short title', `Copy page title text should copy the chip title: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyResult.menuOpen, false, `context menu should close after choosing Copy page title text: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.saveItem.text, 'Save page', `right-clicking a live page chip should show the save action: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.saveResult.menuOpen, false, `context menu should close after choosing Save page: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.saveResult.pageKeys.includes('https://tab-out-smoke-01.com/docs/1'), `Save page should persist the chip URL: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.saveResult.setCount > 0, `Save page should write through chrome.storage.local: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.activeBefore, 'Tabs', `outside-click smoke should start on the Tabs source: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.activeAfter, 'Tabs', `clicking outside an open context menu should dismiss it without activating the underlying source button: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.menuOpen, false, `outside click should dismiss the context menu: ${JSON.stringify(contextMenuSave)}`)

  const tooltip = await measureTooltipFreeze(session)
  assert.ok(tooltip.first, `tooltip should open on chip hover: ${JSON.stringify(tooltip)}`)
  assert.ok(tooltip.second, `tooltip should stay open during an in-chip pointer move: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs(tooltip.first.left - (tooltip.target.textLeft - 8)) <= 1, `tooltip should start over the original chip text: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs((tooltip.first.top + 4) - tooltip.target.textTop) <= 1, `tooltip popup should place its text over the original chip text: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs((tooltip.first.textLeft || 0) - tooltip.target.textLeftExact) <= 0.1, `tooltip text should keep the original chip text x-origin: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs((tooltip.first.textTop || 0) - tooltip.target.textTopExact) <= 0.1, `tooltip text should keep the original chip text y-origin: ${JSON.stringify(tooltip)}`)
  assert.equal(tooltip.first.align, 'start', `tooltip should use start alignment away from viewport edges: ${JSON.stringify(tooltip)}`)
  assert.equal(tooltip.first.topLeftRadius, '0px', `tooltip anchor corner should be square: ${JSON.stringify(tooltip)}`)
  assert.equal(tooltip.first.transitionProperty, 'none', `page chip tooltip should not animate on open or close: ${JSON.stringify(tooltip)}`)
  assert.equal(tooltip.first.transitionDuration, '0s', `page chip tooltip should not transition on open or close: ${JSON.stringify(tooltip)}`)
  assert.equal(tooltip.first.svgCount, 0, `tooltip should not render an arrow svg: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs(tooltip.first.left - tooltip.second.left) <= 1, `tooltip left should freeze after open: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs(tooltip.first.top - tooltip.second.top) <= 1, `tooltip top should freeze after open: ${JSON.stringify(tooltip)}`)
  assert.equal(tooltip.afterScrollTooltipCount, 0, `tooltip should close when the dashboard scrolls: ${JSON.stringify(tooltip)}`)
  if (tooltip.closing) {
    assert.ok(Math.abs(tooltip.first.left - tooltip.closing.left) <= 1, `tooltip left should stay frozen while closing: ${JSON.stringify(tooltip)}`)
    assert.ok(Math.abs(tooltip.first.top - tooltip.closing.top) <= 1, `tooltip top should stay frozen while closing: ${JSON.stringify(tooltip)}`)
  }

  const tooltipHitArea = await measureTooltipTextPaddingHitArea(session)
  assert.ok(tooltipHitArea.target.hitTop < tooltipHitArea.target.textTop, `tooltip hit area should include space above chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.target.hitBottom > tooltipHitArea.target.textBottom, `tooltip hit area should include space below chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.above?.text.includes('enough tooltip text'), `tooltip should open from the vertical space above chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.below?.text.includes('enough tooltip text'), `tooltip should open from the vertical space below chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs(tooltipHitArea.above.left - (tooltipHitArea.target.textLeft - 8)) <= 1, `tooltip should stay anchored to chip text when hovering above its text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.top + 4) - tooltipHitArea.target.textTop) <= 1, `tooltip should remain in text position when hovering above its text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.textLeft || 0) - tooltipHitArea.target.textLeftExact) <= 0.1, `tooltip text x-origin should stay precise from the padding hit area: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.textTop || 0) - tooltipHitArea.target.textTopExact) <= 0.1, `tooltip text y-origin should stay precise from the padding hit area: ${JSON.stringify(tooltipHitArea)}`)

  const activeStateTooltip = await measureTooltipAfterActiveStateChanges(session)
  assert.equal(activeStateTooltip.activeTarget.activeFrame, true, `active-state smoke target should start with an active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.equal(activeStateTooltip.inactiveTarget.activeFrame, false, `active-state smoke target should lose the active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.activeTooltip, `tooltip should open after the chip becomes active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.inactiveTooltip, `tooltip should open after the chip stops being active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textLeft || 0) - activeStateTooltip.activeTarget.textLeftExact) <= 0.1,
    `tooltip x-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textTop || 0) - activeStateTooltip.activeTarget.textTopExact) <= 0.1,
    `tooltip y-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textLeft || 0) - activeStateTooltip.inactiveTarget.textLeftExact) <= 0.1,
    `tooltip x-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textTop || 0) - activeStateTooltip.inactiveTarget.textTopExact) <= 0.1,
    `tooltip y-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`
  )

  const suppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    suppressionMarkerLines.push(await measureSuppressionMarkerTooltipLine(session, markerLabel))
  }
  const suppressionMarkerLineNumbers = suppressionMarkerLines.map(({ result }) => result?.markerLine)
  assert.deepEqual(
    suppressionMarkerLineNumbers.slice(0, 2),
    [1, 2],
    `suppression marker tooltip pills should stay on their widened tooltip lines before viewport-edge fallback: ${JSON.stringify(suppressionMarkerLines)}`
  )
  assert.ok(
    suppressionMarkerLineNumbers[2] === 2 || (
      (suppressionMarkerLineNumbers[2] || 0) > 2 &&
      (suppressionMarkerLines[2].result?.tooltipRight || 0) >= (suppressionMarkerLines[2].result?.viewportRight || 0) - 12
    ),
    `suppression marker tooltip may add a row only when it reaches the browser viewport edge: ${JSON.stringify(suppressionMarkerLines)}`
  )
  for (const line of suppressionMarkerLines) {
    assert.ok(line.result, `suppression marker tooltip should open and expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.text.includes('Shared Workspace'), `suppression marker tooltip should show the hidden title text after line splitting: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 16, `suppression marker should not make wrapped tooltip lines taller: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `suppression marker should sit centered in its tooltip line: ${JSON.stringify(line)}`)
  }
  const compactSuppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    compactSuppressionMarkerLines.push(await measureSuppressionMarkerChipLine(session, markerLabel))
  }
  for (const line of compactSuppressionMarkerLines) {
    assert.ok(line.result, `compact suppression marker should expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 14, `compact suppression marker should stay smaller than the rendered chip line: ${JSON.stringify(line)}`)
    assert.ok(line.result.glyphHeight <= 7, `compact suppression marker glyph should stay small inside its badge: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.glyphCenterDelta) <= 0.75, `compact suppression marker glyph should sit centered inside its badge: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `compact suppression marker should sit centered in its chip line: ${JSON.stringify(line)}`)
  }

  const tooltipLineCounts = [
    await measurePageChipTooltipLineCount(session, 'Marker line one'),
    await measurePageChipTooltipLineCount(session, 'Marker line two'),
    await measurePageChipTooltipLineCount(session, 'Marker line three', {
      forcedTextWidth: 168,
      forcedMaxLines: 3
    })
  ]
  assert.deepEqual(
    tooltipLineCounts.map(({ target }) => target.chipLineCount),
    [1, 2, 3],
    `line-count smoke should cover one-, two-, and three-line chips: ${JSON.stringify(tooltipLineCounts)}`
  )
  for (const lineCount of tooltipLineCounts) {
    assert.ok(lineCount.tooltip, `tooltip should open for line-count check: ${JSON.stringify(lineCount)}`)
    const isViewportConstrained = lineCount.tooltip.right >= lineCount.tooltip.viewportRight - 12
    if (isViewportConstrained) {
      assert.ok(
        lineCount.tooltip.tooltipLineCount >= lineCount.target.chipLineCount,
        `regular page chip tooltip may add rows only when constrained by the browser viewport edge: ${JSON.stringify(lineCount)}`
      )
    } else {
      assert.equal(
        lineCount.tooltip.tooltipLineCount,
        lineCount.target.chipLineCount,
        `regular page chip tooltip should match the visible chip line count when viewport width allows it: ${JSON.stringify(lineCount)}`
      )
    }
    assert.ok(
      lineCount.tooltip.right <= lineCount.tooltip.viewportRight + 1,
      `regular page chip tooltip should stay within the browser viewport: ${JSON.stringify(lineCount)}`
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textLeft - lineCount.target.chipLeftExact) <= 0.1,
      `regular page chip tooltip text should keep the visible chip x-origin: ${JSON.stringify(lineCount)}`
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textTop - lineCount.target.chipTopExact) <= 0.1,
      `regular page chip tooltip text should keep the visible chip y-origin: ${JSON.stringify(lineCount)}`
    )
    const normalizeLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
    const chipLines = lineCount.target.chipLineTexts.map(normalizeLineText).filter(Boolean)
    const tooltipLines = lineCount.tooltip.tooltipLineTexts.map(normalizeLineText).filter(Boolean)
    assert.ok(
      tooltipLines.length >= chipLines.length,
      `regular page chip tooltip should keep at least the visible chip line rows: ${JSON.stringify(lineCount)}`
    )
    for (let index = 0; index < chipLines.length - 1; index += 1) {
      assert.equal(
        tooltipLines[index],
        chipLines[index],
        `regular page chip tooltip should preserve visible line breaks before the tail row: ${JSON.stringify(lineCount)}`
      )
    }
    const lastChipLine = chipLines[chipLines.length - 1]
    const lastTooltipLine = tooltipLines[chipLines.length - 1]
    assert.ok(
      lastTooltipLine?.startsWith(lastChipLine),
      `regular page chip tooltip tail row should start with the same visible text before revealing more: ${JSON.stringify(lineCount)}`
    )
  }
  const structuralTailTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Boundary Alpha', {
    forcedTextWidth: 170,
    forcedMaxLines: 2
  })
  assert.ok(structuralTailTooltip.tooltip, `structural-tail tooltip should open: ${JSON.stringify(structuralTailTooltip)}`)
  assert.equal(
    structuralTailTooltip.tooltip.tooltipLineCount,
    structuralTailTooltip.target.chipLineCount,
    `structural-tail tooltip should keep the visible chip line count: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.text.includes('Example Website') && structuralTailTooltip.tooltip.text.includes('Contentful'),
    `structural-tail tooltip should expand compact suppression markers into text: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('Example Website'),
    `structural-tail tooltip should widen enough for expanded non-tail suppression text instead of clipping it: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.width > structuralTailTooltip.target.chipWidth + 20,
    `structural-tail tooltip should grow wider than the compact chip when non-tail markers expand: ${JSON.stringify(structuralTailTooltip)}`
  )
  const splitStructuralTailTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Line Alpha', {
    forcedTextWidth: 310,
    forcedMaxLines: 2
  })
  assert.ok(splitStructuralTailTooltip.tooltip, `split structural-tail tooltip should open: ${JSON.stringify(splitStructuralTailTooltip)}`)
  assert.equal(
    splitStructuralTailTooltip.tooltip.tooltipLineCount,
    splitStructuralTailTooltip.target.chipLineCount,
    `split structural-tail tooltip should keep the visible chip line count: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.text.includes('Shared Website') && splitStructuralTailTooltip.tooltip.text.includes('Contentful'),
    `split structural-tail tooltip should expand hidden website and source markers: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('Shared Website'),
    `split structural-tail tooltip should keep the expanded website marker on the first visible line: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('env-beta') && splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `split structural-tail tooltip should keep the structural label and trailing marker on the second visible line: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `split structural-tail tooltip lines should not visually overflow: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  const edgeConstrainedTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Edge Alpha', {
    forcedTextWidth: 310,
    forcedMaxLines: 2
  })
  assert.ok(edgeConstrainedTooltip.tooltip, `edge-constrained tooltip should open: ${JSON.stringify(edgeConstrainedTooltip)}`)
  assert.ok(
    edgeConstrainedTooltip.tooltip.right >= edgeConstrainedTooltip.tooltip.viewportRight - 12,
    `edge-constrained tooltip should exercise the browser viewport limit: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.tooltipLineCount >= edgeConstrainedTooltip.target.chipLineCount,
    `edge-constrained tooltip may add rows after it reaches the browser viewport edge: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.text.includes('Shared Website With Long Workspace Label For Tooltip Boundary') && edgeConstrainedTooltip.tooltip.text.includes('Contentful'),
    `edge-constrained tooltip should still expose the expanded hidden markers: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `edge-constrained tooltip lines should wrap instead of overflowing: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  const foldedTooltip = await measureFoldedPageChipTooltipTitleLineCount(session, 'Folded Tooltip Lenses', {
    forcedTextWidth: 270
  })
  assert.ok(foldedTooltip.tooltip, `folded chip tooltip should open: ${JSON.stringify(foldedTooltip)}`)
  assert.equal(
    foldedTooltip.target.titleLineCount,
    1,
    `folded chip visible title row should fit on one line for this smoke: ${JSON.stringify(foldedTooltip)}`
  )
  assert.equal(
    foldedTooltip.tooltip.titleLineCount,
    foldedTooltip.target.titleLineCount,
    `folded chip tooltip title row should match the visible title row line count: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.titleText.includes('Example Optical'),
    `folded chip tooltip should expand the hidden title marker inline: ${JSON.stringify(foldedTooltip)}`
  )
  assert.equal(
    foldedTooltip.tooltip.envCount,
    0,
    `folded chip tooltip should not render env buttons: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.textWidth > foldedTooltip.target.chipTextWidth,
    `folded chip tooltip should grow wider than the compact folded chip when hidden title text expands: ${JSON.stringify(foldedTooltip)}`
  )
  const foldedWrappedTooltip = await measureFoldedPageChipTooltipTitleLineCount(session, 'Folded Tooltip Lenses', {
    forcedTextWidth: 160
  })
  assert.ok(foldedWrappedTooltip.tooltip, `wrapped folded chip tooltip should open: ${JSON.stringify(foldedWrappedTooltip)}`)
  assert.ok(
    foldedWrappedTooltip.target.titleLineCount > 1,
    `wrapped folded chip visible title row should span multiple lines for this smoke: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.equal(
    foldedWrappedTooltip.tooltip.titleLineCount,
    foldedWrappedTooltip.target.titleLineCount,
    `wrapped folded chip tooltip title row should keep the visible title line breaks: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.titleText.includes('Example Optical'),
    `wrapped folded chip tooltip should still expand the hidden title marker: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.equal(
    foldedWrappedTooltip.tooltip.envCount,
    0,
    `wrapped folded chip tooltip should not render env buttons: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  const foldedEnvHover = await measureFoldedEnvHoverTooltips(session, 'Folded Tooltip Lenses')
  assert.deepEqual(
    foldedEnvHover.tooltipTexts,
    [],
    `hovering a folded env button should not open a tooltip: ${JSON.stringify(foldedEnvHover)}`
  )

  const popupHover = await measureTooltipPopupHover(session)
  assert.ok(popupHover.whileHovered, `tooltip should remain open when the pointer moves into the popup: ${JSON.stringify(popupHover)}`)
  assert.ok(
    !popupHover.afterLeaveTooltips.some((text: string) => text === popupHover.first.text),
    `original tooltip should close after the pointer leaves the popup: ${JSON.stringify(popupHover)}`
  )

  const popupClickFocus = await measureTooltipPopupClickFocus(session)
  assert.equal(popupClickFocus.popupStyle?.cursor, 'default', `page chip tooltip popup should keep the default cursor: ${JSON.stringify(popupClickFocus)}`)
  assert.equal(popupClickFocus.popupStyle?.userSelect, 'none', `page chip tooltip popup should not select text when it is used as a click target: ${JSON.stringify(popupClickFocus)}`)
  assert.ok(
    popupClickFocus.updates.some((update: { kind: string; args: [number, { active?: boolean }] }) => (
      update.kind === 'tab' && update.args[1]?.active === true
    )),
    `clicking the page chip tooltip popup should focus the matching tab: ${JSON.stringify(popupClickFocus)}`
  )
  assert.ok(
    popupClickFocus.updates.some((update: { kind: string; args: [number, { focused?: boolean }] }) => (
      update.kind === 'window' && update.args[1]?.focused === true
    )),
    `clicking the page chip tooltip popup should focus the matching window: ${JSON.stringify(popupClickFocus)}`
  )

  const popupWheelScroll = await measureTooltipPopupWheelScroll(session)
  assert.ok(popupWheelScroll.first, `tooltip should open before popup-wheel check: ${JSON.stringify(popupWheelScroll)}`)
  assert.ok(
    popupWheelScroll.after.scrollTop - popupWheelScroll.beforeScrollTop > 72,
    `repeated wheel input over a closing tooltip should keep scrolling the dashboard: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.ok(
    popupWheelScroll.forwardedWheelSteps.every((step: { defaultPrevented: boolean }) => step.defaultPrevented),
    `synthetic continuation wheel events should be captured while the closing tooltip preserves the wheel target: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.ok(
    (popupWheelScroll.forwardedWheelSteps.at(-1)?.scrollTop ?? 0) -
      popupWheelScroll.beforeForwardedWheelTop >
      72,
    `continued wheel input after the tooltip visually closes should keep scrolling the dashboard: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.equal(
    popupWheelScroll.after.tooltipCount,
    0,
    `tooltip should close after popup wheel input scrolls the dashboard: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.equal(
    popupWheelScroll.afterLeaveTooltipCount,
    0,
    `tooltip should close after the pointer leaves the wheel-scrolled popup: ${JSON.stringify(popupWheelScroll)}`
  )

  const historyPopupWheelScroll = await measureHistoryTooltipPopupWheelScroll(session)
  assert.ok(
    historyPopupWheelScroll.target.listScrollHeight > historyPopupWheelScroll.target.listClientHeight,
    `history panel should be scrollable for popup-wheel check: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.after.historyScrollTop > historyPopupWheelScroll.beforeScrollTop.historyScrollTop,
    `repeated wheel input over a closing history tooltip should keep scrolling the history panel: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.dashboardScrollTop,
    historyPopupWheelScroll.beforeScrollTop.dashboardScrollTop,
    `wheel input over a history tooltip should not scroll the dashboard pane first: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.tooltipCount,
    0,
    `history tooltip should close after popup wheel input scrolls the history panel: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveTooltipCount,
    0,
    `history tooltip should close after the pointer leaves the wheel-scrolled popup: ${JSON.stringify(historyPopupWheelScroll)}`
  )

  const windowBlurTooltip = await measureTooltipWindowBlurClose(session)
  assert.ok(windowBlurTooltip.first, `tooltip should open before window-blur check: ${JSON.stringify(windowBlurTooltip)}`)
  assert.deepEqual(windowBlurTooltip.afterBlurTooltips, [], `tooltip should close when the window loses focus: ${JSON.stringify(windowBlurTooltip)}`)

  const visibilityTooltip = await measureTooltipVisibilityChangeClose(session)
  assert.ok(visibilityTooltip.first, `tooltip should open before visibility-change check: ${JSON.stringify(visibilityTooltip)}`)
  assert.deepEqual(
    visibilityTooltip.afterVisibilityChangeTooltips,
    [],
    `tooltip should close synchronously when the page becomes hidden: ${JSON.stringify(visibilityTooltip)}`
  )

  const actionTooltip = await measureActionTooltipClickClose(session)
  assert.ok(actionTooltip.first, `pin tooltip should open before click-close check: ${JSON.stringify(actionTooltip)}`)
  assert.equal(actionTooltip.focusedAfterLeave, true, `pin button should keep focus after click so this smoke covers pointer-focus behavior: ${JSON.stringify(actionTooltip)}`)
  assert.deepEqual(actionTooltip.afterLeaveTooltips, [], `pin tooltip should close after click when the pointer leaves the focused button: ${JSON.stringify(actionTooltip)}`)

  const pageChipReturnTooltip = await measureInteractiveTooltipClickReturnFocus(
    session,
    '.chip-text-truncated',
    'enough tooltip text',
    'page-chip',
    '.chip-text-truncated'
  )
  assert.ok(pageChipReturnTooltip.first.found, `page chip tooltip should open before click-return check: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.active, true, `page chip should be refocused during click-return smoke test: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.focusVisible, false, `page chip click-return focus should not be keyboard-visible focus: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.deepEqual(pageChipReturnTooltip.afterReturnTooltips, [], `page chip tooltip should stay closed after pointer-click return focus: ${JSON.stringify(pageChipReturnTooltip)}`)

  const markerHandoff = await measureMarkerToChipTooltipHandoff(session)
  assert.equal(markerHandoff.target.markerText, '/', `strip indicator should render compact marker text in the chip: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.markerTooltip.found, `strip indicator tooltip should open first: ${JSON.stringify(markerHandoff)}`)
  assert.ok(
    markerHandoff.markerTooltip.tooltips.some((tooltip: { text: string }) => tooltip.text.includes('Hover Handoff Title')),
    `strip indicator should use the chip-level tooltip instead of a marker-only tooltip: ${JSON.stringify(markerHandoff)}`
  )
  assert.ok(markerHandoff.chipTooltip.found, `chip text tooltip should open after moving from the strip indicator to chip text: ${JSON.stringify(markerHandoff)}`)

  const edgeTooltip = await measureTooltipEdgeFlip(session)
  assert.ok(edgeTooltip.first, `tooltip should open near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(['start', 'end'].includes(edgeTooltip.first.align), `tooltip should keep a valid text-edge alignment near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(edgeTooltip.first.visualRight <= edgeTooltip.target.viewportRight + 1, `tooltip should stay within the viewport near the text edge: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(Math.abs(edgeTooltip.first.left - (edgeTooltip.target.textLeft - 8)) <= 1, `tooltip should preserve the original text origin near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  const edgeAnchorRadius = edgeTooltip.first.align === 'end' ? edgeTooltip.first.topRightRadius : edgeTooltip.first.topLeftRadius
  assert.equal(edgeAnchorRadius, '0px', `tooltip anchor corner should be square near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
})

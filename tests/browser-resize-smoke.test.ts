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
    deviceScaleFactor: 1,
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
            textRight: Math.round(rect.right),
            textTop: Math.round(rect.top),
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
            textTop: Math.round(textRect.top),
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

  const tooltip = await measureTooltipFreeze(session)
  assert.ok(tooltip.first, `tooltip should open on chip hover: ${JSON.stringify(tooltip)}`)
  assert.ok(tooltip.second, `tooltip should stay open during an in-chip pointer move: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs(tooltip.first.left - (tooltip.target.textLeft - 8)) <= 1, `tooltip should start over the original chip text: ${JSON.stringify(tooltip)}`)
  assert.ok(Math.abs((tooltip.first.top + 4) - tooltip.target.textTop) <= 2, `tooltip text should sit in place of the original chip text: ${JSON.stringify(tooltip)}`)
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
  assert.ok(Math.abs((tooltipHitArea.above.top + 4) - tooltipHitArea.target.textTop) <= 2, `tooltip should remain in text position when hovering above its text: ${JSON.stringify(tooltipHitArea)}`)

  const suppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    suppressionMarkerLines.push(await measureSuppressionMarkerTooltipLine(session, markerLabel))
  }
  assert.deepEqual(
    suppressionMarkerLines.map(({ result }) => result?.markerLine),
    [1, 2, 3],
    `suppression marker tooltip pills should be checked on the first three wrapped lines: ${JSON.stringify(suppressionMarkerLines)}`
  )
  for (const line of suppressionMarkerLines) {
    assert.ok(line.result, `suppression marker tooltip should open and expose marker geometry: ${JSON.stringify(line)}`)
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

  const popupHover = await measureTooltipPopupHover(session)
  assert.ok(popupHover.whileHovered, `tooltip should remain open when the pointer moves into the popup: ${JSON.stringify(popupHover)}`)
  assert.ok(
    !popupHover.afterLeaveTooltips.some((text: string) => text === popupHover.first.text),
    `original tooltip should close after the pointer leaves the popup: ${JSON.stringify(popupHover)}`
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
  assert.ok(Math.abs(edgeTooltip.first.right - edgeTooltip.target.textRight) <= 12, `tooltip should stay visually attached to the original text near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  const edgeAnchorRadius = edgeTooltip.first.align === 'end' ? edgeTooltip.first.topRightRadius : edgeTooltip.first.topLeftRadius
  assert.equal(edgeAnchorRadius, '0px', `tooltip anchor corner should be square near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
})

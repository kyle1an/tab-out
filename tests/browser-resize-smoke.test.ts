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
const PAGE_CHIP_EXPANSION_SMOKE_LABEL = 'Hover Handoff Title'

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

async function measureInitialTooltipMeasureNodes(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    returnByValue: true,
      expression: `(() => ({
      pageChipMeasureNodes: document.querySelectorAll('.page-chip-tooltip-measure').length,
      historyExpansionMeasureNodes: document.querySelectorAll('.history-entry-title-expansion-measure').length,
      visibleTooltipNodes: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
      }).length
    }))()`
  }).then((result: any) => result.result.value)
}

async function measureLargeBookmarkProgressiveRender(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      window.__tabOutSmokeSetBookmarks?.(1008)
      const trigger = Array.from(document.querySelectorAll('[data-tabout-part="source-option"]'))
        .find((candidate) => candidate.textContent?.trim() === 'Bookmarks')
      trigger?.click()
      const start = performance.now()
      let initial = null
      const wait = () => {
        const activeSource = document.querySelector('[data-tabout-part="source-option"][data-active]')?.textContent?.trim() || ''
        const count = document.querySelectorAll('.domain-block').length
        if (activeSource === 'Bookmarks' && count > 0 && !initial) {
          initial = {
            count,
            elapsedMs: Math.round(performance.now() - start),
            measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length
          }
        }
        if (initial && count >= 1008) {
          resolve({
            initial,
            final: {
              count,
              elapsedMs: Math.round(performance.now() - start),
              measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length
            }
          })
          return
        }
        if (performance.now() - start > 12000) {
          resolve({
            initial,
            final: {
              count,
              elapsedMs: Math.round(performance.now() - start),
              measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length
            }
          })
          return
        }
        setTimeout(wait, 16)
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
          const tooltipText = tooltip.querySelector('.chip-text') || tooltip.querySelector('.history-entry-title-tooltip')
          const textRect = tooltipText?.getBoundingClientRect()
          const textStyles = tooltipText ? window.getComputedStyle(tooltipText) : null
          const textLineHeight = Number.parseFloat(textStyles?.lineHeight || '') || null
          const lineNodes = Array.from(tooltipText?.querySelectorAll('.page-chip-tooltip-line, .history-entry-title-tooltip-line') || [])
          const tooltipLineTexts = lineNodes.length > 0
            ? lineNodes.map((node) => node.textContent || '')
            : [tooltipText?.textContent || '']
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
            textWidth: textRect ? Math.round(textRect.width * 100) / 100 : null,
            textHeight: textRect ? Math.round(textRect.height * 100) / 100 : null,
            textLineHeight,
            text: tooltip.textContent || '',
            tooltipLineCount: textRect && textLineHeight ? Math.max(1, Math.round(textRect.height / textLineHeight)) : null,
            tooltipLineTexts,
            outlineWidth,
            side: tooltip.getAttribute('data-side'),
            align: tooltip.getAttribute('data-align'),
            topLeftRadius: styles.borderTopLeftRadius,
            topRightRadius: styles.borderTopRightRadius,
            transitionDuration: styles.transitionDuration,
            transitionProperty: styles.transitionProperty,
            webkitLineClamp: textStyles?.webkitLineClamp || null,
            svgCount: tooltip.querySelectorAll('svg').length,
            viewportRight: window.innerWidth
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

async function waitForPageChipExpansionRect(session: CdpSession, text: string, timeoutMs = 2000) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}))
        const rect = chip?.getBoundingClientRect()
        const chipText = chip?.querySelector('.chip-text')
        const textRect = chipText?.getBoundingClientRect()
        if (chip instanceof HTMLElement && rect && chipText && textRect && rect.width > 0 && rect.height > 0) {
          const styles = window.getComputedStyle(chipText)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          resolve({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            textLeft: Math.round(textRect.left * 100) / 100,
            textTop: Math.round(textRect.top * 100) / 100,
            textWidth: Math.round(textRect.width * 100) / 100,
            textHeight: Math.round(textRect.height * 100) / 100,
            textLineHeight: Math.round(lineHeight * 100) / 100,
            textLineCount: Math.max(1, Math.round(textRect.height / lineHeight)),
            text: chip.textContent || '',
            visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
              const tooltipRect = tooltip.getBoundingClientRect()
              return tooltipRect.width > 0 && tooltipRect.height > 0 && !tooltip.hasAttribute('data-ending-style')
            }).length,
            viewportRight: window.innerWidth
          })
        } else if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function waitForHistoryEntryExpansionRect(session: CdpSession, text: string, timeoutMs = 2000) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}))
        const rect = entry?.getBoundingClientRect()
        const title = entry?.querySelector('.history-entry-title')
        const titleRect = title?.getBoundingClientRect()
        if (entry instanceof HTMLElement && rect && title instanceof HTMLElement && titleRect && rect.width > 0 && rect.height > 0) {
          const styles = window.getComputedStyle(title)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          const lineNodes = Array.from(title.querySelectorAll('.history-entry-expanded-line'))
          const expandedLineTexts = lineNodes.length > 0
            ? lineNodes.map((node) => node.textContent || '')
            : [title.textContent || '']
          const expandedLineOverflows = lineNodes.map((node) => node.scrollWidth - node.clientWidth > 1)
          resolve({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            titleLeft: Math.round(titleRect.left * 100) / 100,
            titleTop: Math.round(titleRect.top * 100) / 100,
            titleWidth: Math.round(titleRect.width * 100) / 100,
            titleHeight: Math.round(titleRect.height * 100) / 100,
            titleLineHeight: Math.round(lineHeight * 100) / 100,
            expandedLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
            expandedLineTexts,
            expandedLineOverflows,
            text: entry.textContent || '',
            visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
              const tooltipRect = tooltip.getBoundingClientRect()
              return tooltipRect.width > 0 && tooltipRect.height > 0 && !tooltip.hasAttribute('data-ending-style')
            }).length,
            viewportRight: window.innerWidth,
            webkitLineClamp: styles.webkitLineClamp || null
          })
        } else if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(null)
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
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
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
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.moveX,
    y: target.y
  })
  await wait(150)
  const second = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollBy(0, 160)`
  })
  await wait(220)
  const afterScrollExpandedCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-expanded').length`
  }).then((result: any) => result.result.value)

  return { target, first, second, afterScrollExpandedCount, closing: null }
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
        const hitArea = Array.from(document.querySelectorAll('.chip-text-expansion-hit-area'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const chip = hitArea?.closest('.page-chip')
        const chipText = hitArea?.querySelector('.chip-text-truncated')
        const chipRect = chip?.getBoundingClientRect()
        const hitRect = hitArea?.getBoundingClientRect()
        const textRect = chipText?.getBoundingClientRect()
        if (
          chipRect &&
          hitRect &&
          textRect &&
          chipRect.left + 2 < hitRect.left - 1 &&
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
            chipSurfaceX: Math.round(chipRect.left + Math.max(2, (hitRect.left - chipRect.left) / 2)),
            chipSurfaceY: Math.round(textRect.top + Math.min(textRect.height / 2, 10)),
            chipLeft: Math.round(chipRect.left),
            chipRight: Math.round(chipRect.right),
            hitTop: Math.round(hitRect.top),
            hitBottom: Math.round(hitRect.bottom),
            hitLeft: Math.round(hitRect.left),
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

  assert.ok(target, 'expected a page chip expansion hit area for padding hover smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY
  })
  await wait(650)
  const above = await waitForPageChipExpansionRect(session, 'enough tooltip text')

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
  const below = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.chipSurfaceX,
    y: target.chipSurfaceY
  })
  await wait(650)
  const chipSurface = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  return { target, above, below, chipSurface }
}

async function measurePageChipInternalPointerMoveExpansion(session: CdpSession) {
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
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes('enough tooltip text'))
        const chipText = chip?.querySelector('.chip-text-truncated')
        const chipRect = chip?.getBoundingClientRect()
        const textRect = chipText?.getBoundingClientRect()
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          textRect &&
          chipRect.left + 2 < textRect.left - 1 &&
          textRect.width > 120 &&
          textRect.height > 8
        ) {
          resolve({
            x: Math.round(chipRect.left + Math.max(2, (textRect.left - chipRect.left) / 2)),
            y: Math.round(textRect.top + Math.min(textRect.height / 2, 10)),
            chipLeft: Math.round(chipRect.left),
            chipRight: Math.round(chipRect.right),
            textLeft: Math.round(textRect.left),
            textTopExact: Math.round(textRect.top * 100) / 100
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

  assert.ok(target, 'expected a page chip with left-side internal hover surface')

  const before = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-expanded').length`
  }).then((result: any) => result.result.value)

  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes('enough tooltip text'))
      chip?.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: ${target.x},
        clientY: ${target.y},
        pointerId: 1,
        pointerType: 'mouse'
      }))
    })()`
  })
  await wait(650)

  const expansion = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  return { target, before, expansion }
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
    const tooltip = await waitForPageChipExpansionRect(session, 'Example 2 with enough tooltip text')
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
      const expandedChip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
      const expandedText = expandedChip?.querySelector('.chip-text')
      const marker = expandedChip?.querySelector('.chip-title-suppression-marker')
      const tooltipRect = expandedChip?.getBoundingClientRect()
      const textRect = expandedText?.getBoundingClientRect()
      const markerRect = marker?.getBoundingClientRect()
      if (!expandedChip || !expandedText || !marker || !tooltipRect || !textRect || !markerRect) return null

      const textStyles = window.getComputedStyle(expandedText)
      const markerStyles = window.getComputedStyle(marker)
      const lineHeight = Number.parseFloat(textStyles.lineHeight) || 16.25
      const markerLine = Math.round((markerRect.top - textRect.top) / lineHeight) + 1
      const lineTop = textRect.top + (markerLine - 1) * lineHeight
      const markerCenter = markerRect.top + markerRect.height / 2
      const lineCenter = lineTop + lineHeight / 2

      return {
        label: ${JSON.stringify(label)},
        text: expandedChip.textContent || '',
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
  options: { forcedTextWidth?: number; forcedMaxLines?: number; hoverWaitMs?: number; viewportWidth?: number } = {}
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
        if (
          chipText instanceof HTMLElement &&
          rect &&
          (rect.top < 24 || rect.bottom > window.innerHeight - 24)
        ) {
          chipText.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
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
  await wait(options.hoverWaitMs ?? 650)

  const tooltip = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
      const tooltipText = tooltip?.querySelector('.chip-text')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const textRect = tooltipText?.getBoundingClientRect()
      if (!(tooltip instanceof HTMLElement) || !(tooltipText instanceof HTMLElement) || !tooltipRect || !textRect) return null
      const styles = window.getComputedStyle(tooltipText)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
      const lineNodes = Array.from(tooltipText.querySelectorAll('.page-chip-expanded-line'))
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
        visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length,
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
      const tooltip = Array.from(document.querySelectorAll('.page-chip-expanded.page-chip-folded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
      const tooltipText = tooltip?.querySelector('.chip-text')
      const titleRow = tooltip?.querySelector('.chip-title-row')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const titleRect = titleRow?.getBoundingClientRect()
      if (!(tooltip instanceof HTMLElement) || !(tooltipText instanceof HTMLElement) || !(titleRow instanceof HTMLElement) || !tooltipRect || !titleRect) return null
      const styles = window.getComputedStyle(titleRow)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
      return {
        text: tooltip.textContent || '',
        titleText: titleRow.textContent || '',
        envCount: tooltip.querySelectorAll('.chip-env').length,
        visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length,
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
  const expansion = await waitForPageChipExpansionRect(session, marker)
  const first = { found: !!expansion, expansion }

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

async function measurePageChipOriginalSlotLeave(session: CdpSession) {
  const label = 'Tooltip Boundary Alpha'
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
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        if (chipText instanceof HTMLElement) {
          chipText.style.flex = '0 0 130px'
          chipText.style.maxWidth = '130px'
          chipText.style.maxHeight = 'calc(1lh)'
        }
        const chip = chipText?.closest('.page-chip')
        const slot = chip?.closest('[data-tabout-part="slot"]') || chip
        const rect = chipText?.getBoundingClientRect()
        const slotRect = slot?.getBoundingClientRect()
        if (
          chipText instanceof HTMLElement &&
          chip instanceof HTMLElement &&
          slot instanceof HTMLElement &&
          rect &&
          slotRect &&
          slotRect.width > 80 &&
          slotRect.height > 8
        ) {
          resolve({
            startX: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
            slotLeft: Math.round(slotRect.left),
            slotRight: Math.round(slotRect.right),
            slotTop: Math.round(slotRect.top),
            slotBottom: Math.round(slotRect.bottom),
            slotWidth: Math.round(slotRect.width),
            slotHeight: Math.round(slotRect.height),
            textLeft: Math.round(rect.left),
            textTop: Math.round(rect.top),
            chipText: chipText.textContent || '',
            chipTextWidth: Math.round(rect.width)
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

  assert.ok(target, 'expected a page chip to hover for original-slot leave smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)
  const first = await waitForPageChipExpansionRect(session, label)

  assert.ok(first, `page chip should expand before original-slot leave check: ${JSON.stringify({ target, first })}`)
  assert.ok(
    first.right > target.slotRight + 8,
    `original-slot leave smoke needs an expanded-only horizontal area: ${JSON.stringify({ target, first })}`
  )

  const expandedOnlyPoint = {
    x: Math.round(Math.min(first.right - 4, target.slotRight + 16)),
    y: Math.round((Math.max(first.top, target.slotTop) + Math.min(first.bottom, target.slotBottom)) / 2)
  }
  assert.ok(
    expandedOnlyPoint.x > target.slotRight + 1 && expandedOnlyPoint.x < first.right,
    `original-slot leave point should be outside the original slot and inside the expanded chip: ${JSON.stringify({ target, first, expandedOnlyPoint })}`
  )
  assert.ok(
    expandedOnlyPoint.y >= first.top && expandedOnlyPoint.y <= first.bottom,
    `original-slot leave point should stay vertically inside the expanded chip: ${JSON.stringify({ target, first, expandedOnlyPoint })}`
  )

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: expandedOnlyPoint.x,
    y: expandedOnlyPoint.y
  })
  await wait(220)
  const afterOriginalSlotLeave = await waitForPageChipExpansionRect(session, label, 250)

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
    expression: `Array.from(document.querySelectorAll('.page-chip-expanded'))
      .map((chip) => chip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, expandedOnlyPoint, afterOriginalSlotLeave, afterLeaveTooltips }
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
      window.__tabOutSmokeOriginalTabsUpdate = window.__tabOutSmokeOriginalTabsUpdate || chrome.tabs.update
      window.__tabOutSmokeOriginalWindowsUpdate = window.__tabOutSmokeOriginalWindowsUpdate || chrome.windows.update
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return window.__tabOutSmokeOriginalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return window.__tabOutSmokeOriginalWindowsUpdate(...args)
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
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
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
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)
  assert.ok(first, `page chip should expand before in-place click check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  const popupStyle = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)}))
      if (!(chip instanceof HTMLElement)) return null
      const styles = window.getComputedStyle(chip)
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
    expression: `(() => {
      const focusUpdates = window.__tabOutSmokeFocusUpdates || []
      chrome.tabs.update = window.__tabOutSmokeOriginalTabsUpdate
      chrome.windows.update = window.__tabOutSmokeOriginalWindowsUpdate
      return focusUpdates
    })()`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, popupStyle, updates }
}

async function measureHistoryEntryExpansionClickFocus(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.history-entry-list')?.scrollTo(0, 0)
      window.__tabOutSmokeFocusUpdates = []
      window.__tabOutSmokeOriginalTabsUpdate = window.__tabOutSmokeOriginalTabsUpdate || chrome.tabs.update
      window.__tabOutSmokeOriginalWindowsUpdate = window.__tabOutSmokeOriginalWindowsUpdate || chrome.windows.update
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return window.__tabOutSmokeOriginalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return window.__tabOutSmokeOriginalWindowsUpdate(...args)
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
        const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
          .find((candidate) =>
            candidate.closest('.history-entry-row')?.textContent?.includes('Low score history item with enough tooltip text')
          )
        const row = title?.closest('.history-entry-row')
        row?.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = title?.getBoundingClientRect()
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

  assert.ok(target, 'expected a history-panel entry to hover for expansion click smoke test')
  await wait(180)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  assert.ok(first, `history entry should expand before click check: ${JSON.stringify({ target, first })}`)

  const expandedPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  const expandedStyle = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const entry = document.querySelector('.history-entry-expanded')
      if (!entry) return null
	      const styles = window.getComputedStyle(entry)
	      return {
	        cursor: styles.cursor,
	        pointerEvents: styles.pointerEvents,
	        userSelect: styles.userSelect
	      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(80)
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
  await wait(220)

  const updates = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const focusUpdates = window.__tabOutSmokeFocusUpdates || []
      chrome.tabs.update = window.__tabOutSmokeOriginalTabsUpdate
      chrome.windows.update = window.__tabOutSmokeOriginalWindowsUpdate
      return focusUpdates
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  return { target, first, expandedPoint, activationPoint: target, expandedStyle, updates }
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

  async function findPageChipFaviconTarget(label: string) {
    return evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const start = Date.now()
        const wait = () => {
          const chip = Array.from(document.querySelectorAll('.page-chip'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
          const faviconFrame = chip?.querySelector('.chip-favicon-frame')
          const rect = faviconFrame?.getBoundingClientRect()
          if (rect && rect.width > 4 && rect.height > 4) {
            resolve({
              label: ${JSON.stringify(label)},
              x: Math.round(rect.left + rect.width / 2),
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
  const targetFavicon = await findPageChipFaviconTarget('Short title')
  const replacementTarget = await findPageChipTarget('Example 2 with enough tooltip text', 140)
  const historyMatchTarget = await findPageChipTarget('Example 3 with enough tooltip text', 16)

  assert.ok(target, 'expected a live page chip for context menu save smoke test')
  assert.ok(targetFavicon, 'expected a live page chip favicon target for close-hover smoke test')
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
          expanded: chip.classList.contains('page-chip-expanded'),
          tooltipOpen: chip.classList.contains('page-chip-tooltip-open'),
          transitionProperty: styles.transitionProperty,
          width: Math.round(chip.getBoundingClientRect().width),
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
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: targetFavicon.x,
    y: targetFavicon.y
  })
  await wait(180)
  const hoverFaviconState = await readPageChipVisualState(target)
  await openContextMenuAt(target)
  const contextMenuOpenChipState = await readPageChipVisualState(target)
  const firstOpenState = await readContextMenuState()
  assert.ok(restingChipState, `expected chip visual state before context menu: ${JSON.stringify({ target, restingChipState })}`)
  assert.ok(hoverChipState, `expected chip hover visual state before context menu: ${JSON.stringify({ target, hoverChipState })}`)
  assert.ok(hoverFaviconState, `expected chip favicon hover visual state before context menu: ${JSON.stringify({ targetFavicon, hoverFaviconState })}`)
  assert.ok(contextMenuOpenChipState, `expected chip visual state while context menu is open: ${JSON.stringify({ target, contextMenuOpenChipState })}`)
  assert.notEqual(hoverChipState.backgroundColor, restingChipState.backgroundColor, `hover should visibly change the page chip background before the context menu opens: ${JSON.stringify({ restingChipState, hoverChipState })}`)
  assert.equal(hoverChipState.closeButton?.opacity, '0', `hovering the page chip away from its favicon should keep the favicon-slot close button hidden: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverChipState.closeButton?.pointerEvents, 'none', `hovering the page chip away from its favicon should keep the close button non-interactive: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverChipState.faviconContent?.opacity, '1', `hovering the page chip away from its favicon should keep the favicon visible: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverFaviconState.closeButton?.opacity, '1', `hovering the favicon should show the favicon-slot close button: ${JSON.stringify({ hoverFaviconState })}`)
  assert.equal(hoverFaviconState.closeButton?.pointerEvents, 'auto', `hovering the favicon should make the close button interactive: ${JSON.stringify({ hoverFaviconState })}`)
  assert.equal(hoverFaviconState.faviconContent?.opacity, '0', `hovering the favicon should hide the favicon beneath the close button: ${JSON.stringify({ hoverFaviconState })}`)
  assert.equal(contextMenuOpenChipState.contextMenuOpen, true, `context menu trigger should carry an explicit menu-open class: ${JSON.stringify({ contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.backgroundColor, hoverChipState.backgroundColor, `page chip should keep its hover-like background while its context menu is open: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.closeButton?.opacity, hoverChipState.closeButton?.opacity, `opening the context menu from the page chip should not reveal the favicon-slot close button: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.closeButton?.pointerEvents, hoverChipState.closeButton?.pointerEvents, `opening the context menu from the page chip should keep the close button non-interactive: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.faviconContent?.opacity, hoverChipState.faviconContent?.opacity, `opening the context menu from the page chip should keep the favicon visible: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
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
  const tooltipOpenChipState = await readPageChipVisualState(replacementTarget)
  const visibleTooltipCountBeforeMenu = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
      const rect = tooltip.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
    }).length`
  }).then((result: any) => result.result.value)
  assert.equal(tooltipOpenChipState?.expanded, true, `page chip should expand in place before context-menu shield check: ${JSON.stringify({ replacementTarget, tooltipOpenChipState })}`)
  assert.equal(tooltipOpenChipState?.tooltipOpen, true, `page chip should keep the visual-open class while expanded in place: ${JSON.stringify({ tooltipOpenChipState })}`)
  assert.equal(visibleTooltipCountBeforeMenu, 0, `in-place page chip expansion should not create a tooltip popup before context-menu shield check: ${JSON.stringify({ replacementTarget, tooltipOpenChipState, visibleTooltipCountBeforeMenu })}`)
  assert.notEqual(tooltipOpenChipState?.backgroundColor, 'rgba(0, 0, 0, 0)', `expanded page chip should paint an opaque background instead of letting content behind it show through: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  assert.doesNotMatch(tooltipOpenChipState?.backgroundColor || '', /rgba\([^)]*,\s*0\.\d+\)/, `expanded page chip background should not be a low-alpha overlay: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  assert.doesNotMatch(tooltipOpenChipState?.transitionProperty || '', /box-shadow/, `expanded page chip shadow should appear in the same frame as the background instead of transitioning later: ${JSON.stringify({ tooltipOpenChipState })}`)
  assert.equal(tooltipOpenChipState?.closeButton?.opacity, hoverChipState.closeButton?.opacity, `page chip expansion should not reveal the favicon-slot close button: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  assert.equal(tooltipOpenChipState?.faviconContent?.opacity, hoverChipState.faviconContent?.opacity, `page chip expansion should keep the favicon visible away from favicon hover: ${JSON.stringify({ hoverChipState, tooltipOpenChipState })}`)
  await openContextMenuAt(replacementTarget)
  const expandedAfterMenu = await readPageChipVisualState(replacementTarget)
  assert.equal(expandedAfterMenu?.expanded, true, `right-clicking to open a page chip context menu should not collapse an in-place expansion: ${JSON.stringify({ tooltipOpenChipState, expandedAfterMenu })}`)
  const backdropDismissPoint = await findPageChipTarget('Example 2 with enough tooltip text', 40)
  assert.ok(backdropDismissPoint, `expected a page-chip point outside the context menu for backdrop-dismiss smoke: ${JSON.stringify({ replacementTarget })}`)
  const backdropDismissOpenState = await readPageChipVisualState(replacementTarget)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y
  })
  await wait(30)
  const backdropDismissPressedState = await readPageChipVisualState(replacementTarget)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y
  })
  await wait(20)
  const backdropDismissReleasedState = await readPageChipVisualState(replacementTarget)
  await wait(140)
  const backdropDismissAfterState = await readPageChipVisualState(replacementTarget)
  const backdropDismissMenuState = await readContextMenuState()
  assert.equal(backdropDismissOpenState?.contextMenuOpen, true, `page chip should carry the context-menu-open class before backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState })}`)
  assert.equal(backdropDismissPressedState?.contextMenuOpen, true, `page chip should keep the context-menu-open visual class during backdrop dismissal: ${JSON.stringify({ backdropDismissPressedState })}`)
  assert.equal(backdropDismissPressedState?.backgroundColor, backdropDismissOpenState?.backgroundColor, `clicking the context menu backdrop over the page chip should not flash the chip background: ${JSON.stringify({ backdropDismissOpenState, backdropDismissPressedState })}`)
  assert.equal(backdropDismissReleasedState?.backgroundColor, backdropDismissOpenState?.backgroundColor, `page chip should bridge the first backdrop dismissal frame without a background flash: ${JSON.stringify({ backdropDismissOpenState, backdropDismissReleasedState })}`)
  assert.equal(backdropDismissAfterState?.contextMenuOpen, false, `page chip should clear the context-menu-open class after backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState, backdropDismissAfterState })}`)
  assert.equal(backdropDismissAfterState?.expanded, false, `page chip should close its in-place expansion after backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState, backdropDismissAfterState })}`)
  assert.equal(backdropDismissMenuState.visibleMenuCount, 0, `backdrop dismissal over the page chip should close the context menu: ${JSON.stringify({ backdropDismissMenuState })}`)
  await openContextMenuAt(replacementTarget)
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
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
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
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  assert.ok(first, `page chip should expand before in-place wheel check: ${JSON.stringify({ target, first })}`)

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
          expandedCount: document.querySelectorAll('.page-chip-expanded').length,
          tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
        }
      })()`
    }).then((result: any) => result.result.value))
  }
  await wait(620)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const scrollRegion = document.querySelector('.scroll-region')
      return {
        scrollTop: scrollRegion?.scrollTop ?? 0,
        expandedCount: document.querySelectorAll('.page-chip-expanded').length,
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

  const afterLeaveExpandedCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-expanded').length`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, beforeScrollTop, wheelSteps, after, afterLeaveExpandedCount }
}

async function measureHistoryEntryExpansionSurfaceHitArea(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.history-entry-list')?.scrollTo(0, 0)`
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const row = Array.from(document.querySelectorAll('.history-entry-row'))
          .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
        row?.scrollIntoView({ block: 'center', inline: 'nearest' })
        const frame = row?.querySelector('.history-entry-favicon-frame')
        const main = row?.querySelector('.history-entry-main')
        const frameRect = frame?.getBoundingClientRect()
        const mainRect = main?.getBoundingClientRect()
        if (
          row &&
          frameRect &&
          mainRect &&
          frameRect.width > 4 &&
          frameRect.height > 4 &&
          mainRect.top < frameRect.top - 1 &&
          mainRect.bottom > frameRect.bottom + 1
        ) {
          resolve({
            x: Math.round(frameRect.left + frameRect.width / 2),
            aboveY: Math.round(mainRect.top + Math.max(1, (frameRect.top - mainRect.top) / 2)),
            belowY: Math.round(frameRect.bottom + Math.max(1, (mainRect.bottom - frameRect.bottom) / 2)),
            frameTop: Math.round(frameRect.top),
            frameBottom: Math.round(frameRect.bottom),
            mainTop: Math.round(mainRect.top),
            mainBottom: Math.round(mainRect.bottom)
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

  assert.ok(target, 'expected a history entry favicon frame with vertical padding for expansion hit-area smoke test')
  await wait(180)

  async function visibleTooltipTexts() {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
        .filter((tooltip) => !tooltip.hidden && tooltip.getClientRects().length > 0 && window.getComputedStyle(tooltip).visibility !== 'hidden')
        .map((tooltip) => tooltip.textContent || '')`
    }).then((result: any) => result.result.value)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY
  })
  await wait(650)
  const above = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  const aboveTooltipTexts = await visibleTooltipTexts()

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
  const below = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  const belowTooltipTexts = await visibleTooltipTexts()

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  return { target, above, below, aboveTooltipTexts, belowTooltipTexts }
}

async function measureHistoryEntryExpansionWheelScroll(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
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
            candidate.closest('.history-entry-row')?.textContent?.includes('Low score history item with enough tooltip text')
          )
        const row = title?.closest('.history-entry-row')
        row?.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = title?.getBoundingClientRect()
        const entry = title?.closest('.history-entry')
        const slot = entry?.closest('.history-entry-slot') || entry
        const slotRect = slot?.getBoundingClientRect()
        const titleStyles = title ? window.getComputedStyle(title) : null
        const lineHeight = Number.parseFloat(titleStyles?.lineHeight || '') || 0
        const titleMaskImage = titleStyles?.maskImage || titleStyles?.webkitMaskImage || ''
        const list = document.querySelector('.history-entry-list')
        if (rect && slotRect && list && rect.width > 120 && rect.height > 8) {
          const titleLineCount = Math.max(1, Math.round(rect.height / lineHeight))
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
            y: Math.round(rect.top + rect.height / 2),
            titleLineCount,
            titleLineTexts: collectLineTexts(title, titleLineCount),
            titleLeft: Math.round(rect.left),
            titleLeftExact: Math.round(rect.left * 100) / 100,
            titleTop: Math.round(rect.top),
            titleTopExact: Math.round(rect.top * 100) / 100,
            titleWidth: Math.round(rect.width),
            titleWidthExact: Math.round(rect.width * 100) / 100,
            titleHeight: Math.round(rect.height * 100) / 100,
            titleLineHeight: lineHeight,
            titleMaskImage,
            titleWebkitLineClamp: titleStyles?.webkitLineClamp || null,
            slotLeft: Math.round(slotRect.left),
            slotRight: Math.round(slotRect.right),
            slotTop: Math.round(slotRect.top),
            slotBottom: Math.round(slotRect.bottom),
            slotWidth: Math.round(slotRect.width),
            slotHeight: Math.round(slotRect.height),
            listScrollHeight: list.scrollHeight,
            listClientHeight: list.clientHeight,
            listMaxScrollTop: Math.max(0, list.scrollHeight - list.clientHeight)
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

  assert.ok(target, 'expected a history-panel entry to hover for expansion wheel smoke test')
  await wait(180)

  const scrollbarGeometry = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const panel = document.querySelector('.tab-history-panel')
      const list = document.querySelector('.history-entry-list')
      const scrollbar = document.querySelector('.history-entry-scrollbar')
      const thumb = document.querySelector('.history-entry-scrollbar-thumb')
      const panelRect = panel?.getBoundingClientRect()
      const listRect = list?.getBoundingClientRect()
      const scrollbarRect = scrollbar?.getBoundingClientRect()
      const thumbRect = thumb?.getBoundingClientRect()
      const listStyles = list ? window.getComputedStyle(list) : null
      if (!panelRect || !listRect || !scrollbarRect || !thumbRect || !list) return null
      return {
        listClientHeight: list.clientHeight,
        listRight: Math.round(listRect.right * 100) / 100,
        listScrollHeight: list.scrollHeight,
        nativeScrollbarWidth: listStyles?.scrollbarWidth || '',
        panelRight: Math.round(panelRect.right * 100) / 100,
        scrollbarRight: Math.round(scrollbarRect.right * 100) / 100,
        scrollbarWidth: Math.round(scrollbarRect.width * 100) / 100,
        thumbHeight: Math.round(thumbRect.height * 100) / 100,
        viewportWidth: window.innerWidth
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')

  assert.ok(first, `history entry should expand before wheel check: ${JSON.stringify({ target, first })}`)

  const tooltipOpenEntryState = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      const row = Array.from(document.querySelectorAll('.history-entry-row'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      const scrollbar = document.querySelector('.history-entry-scrollbar')
      const styles = entry ? window.getComputedStyle(entry) : null
      const rowStyles = row ? window.getComputedStyle(row) : null
      const indexStyles = row?.firstElementChild instanceof HTMLElement ? window.getComputedStyle(row.firstElementChild) : null
      const scrollbarStyles = scrollbar ? window.getComputedStyle(scrollbar) : null
      return {
        backgroundColor: styles?.backgroundColor || '',
        expandedZIndex: styles?.zIndex || '',
        expandedInsideHistoryList: !!entry?.closest('.history-entry-list'),
        expandedInsidePanel: !!entry?.closest('.tab-history-panel'),
        expandedInsideDashboardShell: !!entry?.closest('[data-tabout="dashboard-shell"]'),
        expandedInsideOverlay: !!entry?.closest('.history-entry-overlay'),
        indexColor: indexStyles?.color || '',
        rowOpacity: rowStyles?.opacity || '',
        scrollbarZIndex: scrollbarStyles?.zIndex || '',
        rowExpandedOpen: row?.classList.contains('history-entry-row-expanded-open') || false,
        expandedOpen: entry?.classList.contains('history-entry-expanded-open') || false
      }
    })()`
  }).then((result: any) => result.result.value)

  const expandedPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  assert.ok(
    first.right > target.slotRight + 8,
    `history original-slot leave smoke needs an expanded-only horizontal area: ${JSON.stringify({ target, first })}`
  )
  const expandedOnlyPoint = {
    x: Math.round(Math.min(first.right - 4, target.slotRight + 16)),
    y: Math.round((Math.max(first.top, target.slotTop) + Math.min(first.bottom, target.slotBottom)) / 2)
  }
  assert.ok(
    expandedOnlyPoint.x > target.slotRight + 1 && expandedOnlyPoint.x < first.right,
    `history original-slot leave point should be outside the original slot and inside the expanded entry: ${JSON.stringify({ target, first, expandedOnlyPoint })}`
  )
	  const expandedOnlyHitTarget = await evaluateWithNavigationRetry(session, {
	    returnByValue: true,
	    expression: `(() => {
	      const expandedEntry = Array.from(document.querySelectorAll('.history-entry-expanded'))
	        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
	      const node = document.elementFromPoint(${JSON.stringify(expandedOnlyPoint.x)}, ${JSON.stringify(expandedOnlyPoint.y)})
	      const entry = node instanceof Element ? node.closest('.history-entry-expanded') : null
	      return {
	        className: node instanceof Element ? node.className || '' : '',
	        hitInsideExpanded: !!entry,
	        text: entry?.textContent || '',
	        visualText: expandedEntry?.textContent || ''
	      }
	    })()`
  }).then((result: any) => result.result.value)

  const expandedOnlyClipCheck = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const expandedEntry = Array.from(document.querySelectorAll('.history-entry-expanded'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      if (!(expandedEntry instanceof HTMLElement)) return { hitInsideExpanded: false, text: '' }
      const previousPointerEvents = expandedEntry.style.pointerEvents
      expandedEntry.style.pointerEvents = 'auto'
      const node = document.elementFromPoint(${JSON.stringify(expandedOnlyPoint.x)}, ${JSON.stringify(expandedOnlyPoint.y)})
      const entry = node instanceof Element ? node.closest('.history-entry-expanded') : null
      expandedEntry.style.pointerEvents = previousPointerEvents
      return {
        className: node instanceof Element ? node.className || '' : '',
        hitInsideExpanded: !!entry,
        text: entry?.textContent || ''
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: expandedOnlyPoint.x,
    y: expandedOnlyPoint.y
  })
  await wait(220)
  const afterOriginalSlotLeave = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text', 250)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const reopened = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  assert.ok(reopened, `history entry should reopen before wheel check: ${JSON.stringify({ target, first, afterOriginalSlotLeave })}`)

  const beforeScrollTop = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      return {
        dashboardScrollTop: document.querySelector('.scroll-region')?.scrollTop ?? 0,
        historyScrollTop: document.querySelector('.history-entry-list')?.scrollTop ?? 0
      }
    })()`
  }).then((result: any) => result.result.value)

  const wheelDeltaY = beforeScrollTop.historyScrollTop >= target.listMaxScrollTop - 1 ? -18 : 18
  for (let index = 0; index < 4; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: wheelDeltaY,
      x: target.x,
      y: target.y
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
        expansionCount: document.querySelectorAll('.history-entry-expanded').length,
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

  const afterLeaveExpansionState = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => ({
      expansionCount: document.querySelectorAll('.history-entry-expanded').length,
      tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
    }))()`
  }).then((result: any) => result.result.value)

  return { target, first, scrollbarGeometry, expandedPoint, expandedOnlyPoint, expandedOnlyClipCheck, expandedOnlyHitTarget, afterOriginalSlotLeave, tooltipOpenEntryState, beforeScrollTop, wheelDeltaY, after, afterLeaveExpansionState }
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
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
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

  assert.ok(target, 'expected a page chip for expansion window-blur smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateWithNavigationRetry(session, {
    expression: `window.dispatchEvent(new Event('blur'))`
  })
  await wait(240)

  const afterBlurTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('.page-chip-expanded'))
      .map((chip) => chip.textContent || '')`
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
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
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

  assert.ok(target, 'expected a page chip for expansion visibility-change smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(180)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

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
    expression: `Array.from(document.querySelectorAll('.page-chip-expanded'))
      .map((chip) => chip.textContent || '')`
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

  assert.ok(target, 'expected a chip with a strip indicator for expansion handoff smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.markerX,
    y: target.y
  })
  await wait(650)
  const markerTooltipExpansion = await waitForPageChipExpansionRect(session, 'Hover Handoff Title')
  const markerTooltip = {
    found: !!markerTooltipExpansion,
    expansion: markerTooltipExpansion,
    tooltips: await getVisibleTooltipTexts(session)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.textX,
    y: target.y
  })
  const chipTooltipExpansion = await waitForPageChipExpansionRect(session, 'Hover Handoff Title')
  const chipTooltip = {
    found: !!chipTooltipExpansion,
    expansion: chipTooltipExpansion,
    tooltips: await getVisibleTooltipTexts(session)
  }

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

  assert.ok(target, 'expected a right-edge page chip to hover for expansion smoke test')

  await wait(250)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)
  const first = await waitForPageChipExpansionRect(session, 'viewport-edge')

  return { target, first }
}

async function measureCompactTitleVariantExpansion(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddCompactTitleVariantTabs?.()`
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
            candidate.textContent?.includes('Order Page') &&
            candidate.textContent?.includes('productId=1060') &&
            candidate.textContent?.includes('productId=9707')
          )
        const chipRect = chip?.getBoundingClientRect()
        const titleRow = chip?.querySelector('.chip-title-row')
        const variantLabels = Array.from(chip?.querySelectorAll('.chip-title-variant-label') || [])
        const titleRect = titleRow?.getBoundingClientRect()
        const labelRects = variantLabels.map((label) => label.getBoundingClientRect())
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)
        ) {
          chip.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (
          chip instanceof HTMLElement &&
          titleRow instanceof HTMLElement &&
          chipRect &&
          titleRect &&
          labelRects.length === 2 &&
          labelRects.every((rect) => rect.width > 40 && rect.height > 8)
        ) {
          const contentRight = Math.max(titleRect.right, ...labelRects.map((rect) => rect.right)) + 20
          resolve({
            x: Math.round(titleRect.left + Math.min(24, titleRect.width / 2)),
            y: Math.round(titleRect.top + Math.min(titleRect.height / 2, 10)),
            chipWidth: Math.round(chipRect.width),
            contentWidth: Math.round(contentRight - chipRect.left),
            titleWidth: Math.round(titleRect.width),
            labelWidths: labelRects.map((rect) => Math.round(rect.width))
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

  assert.ok(target, 'expected compact same-title URL variant chip for expansion width smoke')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(650)

  const expansion = await waitForPageChipExpansionRect(session, 'Order Page')
  const expandedVariantLabels = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes('Order Page'))
      return Array.from(chip?.querySelectorAll('.chip-title-variant-label') || []).map((label) => {
        const rect = label.getBoundingClientRect()
        return {
          text: label.textContent || '',
          clientWidth: Math.round((label.clientWidth || 0) * 100) / 100,
          scrollWidth: Math.round((label.scrollWidth || 0) * 100) / 100,
          width: Math.round(rect.width * 100) / 100
        }
      })
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(260)

  return { target, expansion, expandedVariantLabels }
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
  const initialTooltipMeasureNodes = await measureInitialTooltipMeasureNodes(session)

  assert.ok(wide.cardCount >= 12, `dashboard should render enough cards for a column smoke test: ${JSON.stringify(wide)}`)
  assert.ok(wide.columns > narrow.columns, `expected columns to shrink after resize, got ${wide.columns} -> ${narrow.columns}`)
  assert.notEqual(wide.firstWidth, narrow.firstWidth, 'card width should respond to viewport resize')
  assert.equal(initialTooltipMeasureNodes.pageChipMeasureNodes, 0, `page chips should not mount hidden tooltip measurement nodes before hover: ${JSON.stringify(initialTooltipMeasureNodes)}`)
  assert.equal(initialTooltipMeasureNodes.historyExpansionMeasureNodes, 0, `history rows should not mount hidden expansion measurement nodes before hover: ${JSON.stringify(initialTooltipMeasureNodes)}`)
  assert.equal(initialTooltipMeasureNodes.visibleTooltipNodes, 0, `dashboard should not show tooltip popups before hover: ${JSON.stringify(initialTooltipMeasureNodes)}`)

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

  const expansion = await measureTooltipFreeze(session)
  assert.ok(expansion.first, `page chip should expand in place on hover: ${JSON.stringify(expansion)}`)
  assert.ok(expansion.second, `page chip should stay expanded during an in-chip pointer move: ${JSON.stringify(expansion)}`)
  assert.ok((expansion.first.width || 0) > expansion.target.textRight - expansion.target.textLeft + 8, `page chip expansion should grow wider than the resting text: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs((expansion.first.textLeft || 0) - expansion.target.textLeftExact) <= 0.1, `page chip expanded text should keep the original chip text x-origin: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs((expansion.first.textTop || 0) - expansion.target.textTopExact) <= 0.1, `page chip expanded text should keep the original chip text y-origin: ${JSON.stringify(expansion)}`)
  assert.equal(expansion.first.visibleTooltipCount, 0, `page chip text expansion should not create a tooltip popup: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs(expansion.first.left - expansion.second.left) <= 1, `page chip expansion left should freeze after open: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs(expansion.first.top - expansion.second.top) <= 1, `page chip expansion top should freeze after open: ${JSON.stringify(expansion)}`)
  assert.equal(expansion.afterScrollExpandedCount, 0, `page chip expansion should close when the dashboard scrolls: ${JSON.stringify(expansion)}`)

  const tooltipHitArea = await measureTooltipTextPaddingHitArea(session)
  assert.ok(tooltipHitArea.target.hitTop < tooltipHitArea.target.textTop, `expansion hit area should include space above chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.target.hitBottom > tooltipHitArea.target.textBottom, `expansion hit area should include space below chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.target.chipSurfaceX < tooltipHitArea.target.hitLeft, `surface-hover smoke should target chip space outside the text hit area: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.above?.text.includes('enough tooltip text'), `page chip should expand from the vertical space above chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.below?.text.includes('enough tooltip text'), `page chip should expand from the vertical space below chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.chipSurface?.text.includes('enough tooltip text'), `page chip should expand from the non-text chip surface: ${JSON.stringify(tooltipHitArea)}`)
  assert.equal(tooltipHitArea.above?.visibleTooltipCount, 0, `page chip expansion from hit-area padding should not create a tooltip popup: ${JSON.stringify(tooltipHitArea)}`)
  assert.equal(tooltipHitArea.chipSurface?.visibleTooltipCount, 0, `page chip expansion from the non-text chip surface should not create a tooltip popup: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.textLeft || 0) - tooltipHitArea.target.textLeftExact) <= 0.1, `expanded chip text x-origin should stay precise from the padding hit area: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.textTop || 0) - tooltipHitArea.target.textTopExact) <= 0.1, `expanded chip text y-origin should stay precise from the padding hit area: ${JSON.stringify(tooltipHitArea)}`)

  const internalPointerMoveExpansion = await measurePageChipInternalPointerMoveExpansion(session)
  assert.equal(internalPointerMoveExpansion.before, 0, `internal pointer-move smoke should start without an expanded chip: ${JSON.stringify(internalPointerMoveExpansion)}`)
  assert.ok(
    internalPointerMoveExpansion.expansion?.text.includes('enough tooltip text'),
    `page chip should expand when pointer movement starts inside the chip surface: ${JSON.stringify(internalPointerMoveExpansion)}`
  )
  assert.equal(
    internalPointerMoveExpansion.expansion?.visibleTooltipCount,
    0,
    `internal pointer-move expansion should not create a tooltip popup: ${JSON.stringify(internalPointerMoveExpansion)}`
  )

  const activeStateTooltip = await measureTooltipAfterActiveStateChanges(session)
  assert.equal(activeStateTooltip.activeTarget.activeFrame, true, `active-state smoke target should start with an active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.equal(activeStateTooltip.inactiveTarget.activeFrame, false, `active-state smoke target should lose the active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.activeTooltip, `page chip should expand after the chip becomes active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.inactiveTooltip, `page chip should expand after the chip stops being active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textLeft || 0) - activeStateTooltip.activeTarget.textLeftExact) <= 0.1,
    `expanded chip x-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textTop || 0) - activeStateTooltip.activeTarget.textTopExact) <= 0.1,
    `expanded chip y-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textLeft || 0) - activeStateTooltip.inactiveTarget.textLeftExact) <= 0.1,
    `expanded chip x-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textTop || 0) - activeStateTooltip.inactiveTarget.textTopExact) <= 0.1,
    `expanded chip y-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`
  )

  const suppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    suppressionMarkerLines.push(await measureSuppressionMarkerTooltipLine(session, markerLabel))
  }
  const suppressionMarkerLineNumbers = suppressionMarkerLines.map(({ result }) => result?.markerLine)
  assert.deepEqual(
    suppressionMarkerLineNumbers,
    [1, 2, 3],
    `suppression marker expansion should keep marker labels on the same visible chip lines: ${JSON.stringify(suppressionMarkerLines)}`
  )
  for (const line of suppressionMarkerLines) {
    assert.ok(line.result, `suppression marker expansion should expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.text.includes('Shared Workspace'), `suppression marker expansion should show the hidden title text in place: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 16, `suppression marker should not make wrapped expanded chip lines taller: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `suppression marker should sit centered in its expanded chip line: ${JSON.stringify(line)}`)
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
    assert.ok(lineCount.tooltip, `page chip should expand for line-count check: ${JSON.stringify(lineCount)}`)
    assert.equal(
      lineCount.tooltip.visibleTooltipCount,
      0,
      `page chip line-count expansion should not create a tooltip popup: ${JSON.stringify(lineCount)}`
    )
    const isViewportConstrained = lineCount.tooltip.right >= lineCount.tooltip.viewportRight - 12
    if (isViewportConstrained) {
      assert.ok(
        lineCount.tooltip.tooltipLineCount >= lineCount.target.chipLineCount,
        `regular page chip expansion may add rows only when constrained by the browser viewport edge: ${JSON.stringify(lineCount)}`
      )
    } else {
      assert.equal(
        lineCount.tooltip.tooltipLineCount,
        lineCount.target.chipLineCount,
        `regular page chip expansion should match the visible chip line count when viewport width allows it: ${JSON.stringify(lineCount)}`
      )
    }
    assert.ok(
      lineCount.tooltip.right <= lineCount.tooltip.viewportRight + 1,
      `regular page chip expansion should stay within the browser viewport: ${JSON.stringify(lineCount)}`
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textLeft - lineCount.target.chipLeftExact) <= 0.1,
      `regular page chip expansion text should keep the visible chip x-origin: ${JSON.stringify(lineCount)}`
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textTop - lineCount.target.chipTopExact) <= 0.1,
      `regular page chip expansion text should keep the visible chip y-origin: ${JSON.stringify(lineCount)}`
    )
    const normalizeLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
    const chipLines = lineCount.target.chipLineTexts.map(normalizeLineText).filter(Boolean)
    const tooltipLines = lineCount.tooltip.tooltipLineTexts.map(normalizeLineText).filter(Boolean)
    assert.ok(
      tooltipLines.length >= chipLines.length,
      `regular page chip expansion should keep at least the visible chip line rows: ${JSON.stringify(lineCount)}`
    )
    for (let index = 0; index < chipLines.length - 1; index += 1) {
      assert.equal(
        tooltipLines[index],
        chipLines[index],
        `regular page chip expansion should preserve visible line breaks before the tail row: ${JSON.stringify(lineCount)}`
      )
    }
    const lastChipLine = chipLines[chipLines.length - 1]
    const lastTooltipLine = tooltipLines[chipLines.length - 1]
    assert.ok(
      lastTooltipLine?.startsWith(lastChipLine),
      `regular page chip expansion tail row should start with the same visible text before revealing more: ${JSON.stringify(lineCount)}`
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
    !structuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('env-alpha') &&
      structuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('env-alpha') &&
      structuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `structural-tail tooltip should split before the structural marker without duplicating it: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.width > structuralTailTooltip.target.chipWidth + 20,
    `structural-tail tooltip should grow wider than the compact chip when non-tail markers expand: ${JSON.stringify(structuralTailTooltip)}`
  )
  const oneLineStructuralTailTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Boundary Alpha', {
    forcedTextWidth: 130,
    forcedMaxLines: 1,
    viewportWidth: 1600
  })
  assert.ok(oneLineStructuralTailTooltip.tooltip, `one-line structural-tail tooltip should open: ${JSON.stringify(oneLineStructuralTailTooltip)}`)
  assert.equal(
    oneLineStructuralTailTooltip.target.chipLineCount,
    1,
    `one-line structural-tail smoke target should render as one visible chip line: ${JSON.stringify(oneLineStructuralTailTooltip)}`
  )
  assert.equal(
    oneLineStructuralTailTooltip.tooltip.tooltipLineCount,
    1,
    `one-line structural-tail tooltip should widen enough to stay on one line: ${JSON.stringify(oneLineStructuralTailTooltip)}`
  )
  const wrappedContentfulScreenshotTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Screenshot Alpha', {
    forcedTextWidth: 280,
    forcedMaxLines: 2,
    viewportWidth: 1600
  })
  assert.ok(wrappedContentfulScreenshotTooltip.tooltip, `wrapped Contentful tooltip should open: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`)
  assert.equal(
    wrappedContentfulScreenshotTooltip.target.chipLineCount,
    2,
    `wrapped Contentful smoke target should render as two visible chip lines so line 2 carries only the trailing marker: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`
  )
  assert.equal(
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineCount,
    2,
    `wrapped Contentful tooltip should split the expanded title into two rows even when chip line 2 has no text node: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`
  )
  assert.ok(
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[0]?.includes('dev2') &&
      !wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[1]?.includes('dev2') &&
      wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `wrapped Contentful tooltip should keep dev2 on row 1 and Contentful on row 2: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`
  )
  const wrappedTrailingMarkerTooltip = await measurePageChipTooltipLineCount(session, 'Wrap Trailing Marker Alpha', {
    forcedTextWidth: 230,
    forcedMaxLines: 2,
    viewportWidth: 1600
  })
  assert.ok(wrappedTrailingMarkerTooltip.tooltip, `wrapped trailing-marker tooltip should open: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`)
  assert.equal(
    wrappedTrailingMarkerTooltip.target.chipLineCount,
    2,
    `wrapped trailing-marker chip should render as two visible lines so line 2 carries only the trailing suppression marker: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  assert.equal(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineCount,
    2,
    `wrapped trailing-marker tooltip should split when the chip wraps with only a trailing suppression marker on line 2: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  assert.ok(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[0]?.includes('Wrap Trailing Marker Alpha') &&
      !wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[0]?.includes('JIRA') &&
      wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[1]?.includes('JIRA'),
    `wrapped trailing-marker tooltip should keep the title on row 1 and drop the JIRA marker onto row 2: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  assert.ok(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `wrapped trailing-marker tooltip lines should not visually overflow: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
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
    !splitStructuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('env-beta'),
    `split structural-tail tooltip should not duplicate the structural marker into the first row: ${JSON.stringify(splitStructuralTailTooltip)}`
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
  assert.ok(foldedTooltip.tooltip, `folded chip should expand in place: ${JSON.stringify(foldedTooltip)}`)
  assert.equal(
    foldedTooltip.tooltip.visibleTooltipCount,
    0,
    `folded chip expansion should not create a tooltip popup: ${JSON.stringify(foldedTooltip)}`
  )
  assert.equal(
    foldedTooltip.target.titleLineCount,
    1,
    `folded chip visible title row should fit on one line for this smoke: ${JSON.stringify(foldedTooltip)}`
  )
  assert.equal(
    foldedTooltip.tooltip.titleLineCount,
    foldedTooltip.target.titleLineCount,
    `folded chip expansion title row should match the visible title row line count: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.titleText.includes('Example Optical'),
    `folded chip expansion should expand the hidden title marker inline: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.envCount > 0,
    `folded chip expansion should keep the existing env buttons in the chip: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.textWidth > foldedTooltip.target.chipTextWidth,
    `folded chip expansion should grow wider than the compact folded chip when hidden title text expands: ${JSON.stringify(foldedTooltip)}`
  )
  const foldedWrappedTooltip = await measureFoldedPageChipTooltipTitleLineCount(session, 'Folded Tooltip Lenses', {
    forcedTextWidth: 160
  })
  assert.ok(foldedWrappedTooltip.tooltip, `wrapped folded chip should expand in place: ${JSON.stringify(foldedWrappedTooltip)}`)
  assert.equal(
    foldedWrappedTooltip.tooltip.visibleTooltipCount,
    0,
    `wrapped folded chip expansion should not create a tooltip popup: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.target.titleLineCount > 1,
    `wrapped folded chip visible title row should span multiple lines for this smoke: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.equal(
    foldedWrappedTooltip.tooltip.titleLineCount,
    foldedWrappedTooltip.target.titleLineCount,
    `wrapped folded chip expansion title row should keep the visible title line breaks: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.titleText.includes('Example Optical'),
    `wrapped folded chip expansion should still expand the hidden title marker: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.envCount > 0,
    `wrapped folded chip expansion should keep the existing env buttons in the chip: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  const foldedEnvHover = await measureFoldedEnvHoverTooltips(session, 'Folded Tooltip Lenses')
  assert.deepEqual(
    foldedEnvHover.tooltipTexts,
    [],
    `hovering a folded env button should not open a tooltip: ${JSON.stringify(foldedEnvHover)}`
  )

  const originalSlotLeave = await measurePageChipOriginalSlotLeave(session)
  assert.equal(
    originalSlotLeave.first.visibleTooltipCount,
    0,
    `page chip expansion should not create a tooltip popup: ${JSON.stringify(originalSlotLeave)}`
  )
  assert.equal(
    originalSlotLeave.afterOriginalSlotLeave,
    null,
    `page chip should collapse when the pointer leaves the original chip slot, even inside the grown bounds: ${JSON.stringify(originalSlotLeave)}`
  )
  assert.ok(
    !originalSlotLeave.afterLeaveTooltips.some((text: string) => text === originalSlotLeave.first.text),
    `page chip expansion should stay closed after the pointer leaves the original chip slot: ${JSON.stringify(originalSlotLeave)}`
  )

  const popupClickFocus = await measureTooltipPopupClickFocus(session)
  assert.equal(popupClickFocus.popupStyle?.cursor, 'default', `expanded page chip should keep the default cursor: ${JSON.stringify(popupClickFocus)}`)
  assert.equal(popupClickFocus.first.visibleTooltipCount, 0, `clickable expanded page chip should not create a tooltip popup: ${JSON.stringify(popupClickFocus)}`)
  assert.ok(
    popupClickFocus.updates.some((update: { kind: string; args: [number, { active?: boolean }] }) => (
      update.kind === 'tab' && update.args[1]?.active === true
    )),
    `clicking the expanded page chip should focus the matching tab: ${JSON.stringify(popupClickFocus)}`
  )
  assert.ok(
    popupClickFocus.updates.some((update: { kind: string; args: [number, { focused?: boolean }] }) => (
      update.kind === 'window' && update.args[1]?.focused === true
    )),
    `clicking the expanded page chip should focus the matching window: ${JSON.stringify(popupClickFocus)}`
  )
  const historyPopupClickFocus = await measureHistoryEntryExpansionClickFocus(session)
	  assert.equal(historyPopupClickFocus.expandedStyle?.cursor, 'default', `expanded history entry should keep the default cursor: ${JSON.stringify(historyPopupClickFocus)}`)
	  assert.equal(historyPopupClickFocus.expandedStyle?.pointerEvents, 'none', `expanded history entry should let native pointer and wheel input reach the original row underneath: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.equal(historyPopupClickFocus.first.visibleTooltipCount, 0, `expanded history entry should not create a tooltip popup: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.ok(
    historyPopupClickFocus.updates.some((update: { kind: string; args: [number, { active?: boolean }] }) => (
      update.kind === 'tab' && update.args[1]?.active === true
    )),
    `clicking the expanded history entry should focus the matching tab: ${JSON.stringify(historyPopupClickFocus)}`
  )
  assert.ok(
    historyPopupClickFocus.updates.some((update: { kind: string; args: [number, { focused?: boolean }] }) => (
      update.kind === 'window' && update.args[1]?.focused === true
    )),
    `clicking the expanded history entry should focus the matching window: ${JSON.stringify(historyPopupClickFocus)}`
  )

  const popupWheelScroll = await measureTooltipPopupWheelScroll(session)
  assert.ok(popupWheelScroll.first, `page chip should expand before wheel check: ${JSON.stringify(popupWheelScroll)}`)
  assert.equal(popupWheelScroll.first.visibleTooltipCount, 0, `expanded page chip wheel target should not create a tooltip popup: ${JSON.stringify(popupWheelScroll)}`)
  assert.ok(
    popupWheelScroll.after.scrollTop - popupWheelScroll.beforeScrollTop > 72,
    `repeated wheel input over an expanded page chip should keep scrolling the dashboard: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.equal(
    popupWheelScroll.after.expandedCount,
    0,
    `page chip expansion should close after wheel input scrolls the dashboard: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.equal(
    popupWheelScroll.afterLeaveExpandedCount,
    0,
    `page chip expansion should stay closed after the pointer leaves the wheel-scrolled chip: ${JSON.stringify(popupWheelScroll)}`
  )

  const historyPopupWheelScroll = await measureHistoryEntryExpansionWheelScroll(session)
  assert.ok(
    Math.abs(historyPopupWheelScroll.first.titleLeft - historyPopupWheelScroll.target.titleLeftExact) <= 0.1,
    `expanded history entry should keep the title text x-origin: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    Math.abs(historyPopupWheelScroll.first.titleTop - historyPopupWheelScroll.target.titleTopExact) <= 0.1,
    `expanded history entry should keep the title text y-origin: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.scrollbarGeometry,
    `history panel should render a local scrollbar mirror: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    Math.abs(historyPopupWheelScroll.scrollbarGeometry.scrollbarRight - historyPopupWheelScroll.scrollbarGeometry.panelRight) <= 1,
    `history scrollbar mirror should sit on the history panel edge: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.scrollbarGeometry.listRight - historyPopupWheelScroll.scrollbarGeometry.scrollbarRight > 400,
    `history scrollbox should stay wide for expansion while the visible scrollbar stays local: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.scrollbarGeometry.nativeScrollbarWidth,
    'none',
    `native history scrollbar should be hidden behind the local mirror: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(historyPopupWheelScroll.first.visibleTooltipCount, 0, `history expansion should not create a tooltip popup: ${JSON.stringify(historyPopupWheelScroll)}`)
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedOpen,
    true,
    `history entry should keep an explicit expanded-open class while expanded: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.rowExpandedOpen,
    true,
    `dimmed history row should carry expanded-open state on the opacity owner while expanded: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    Number(historyPopupWheelScroll.tooltipOpenEntryState.expandedZIndex) > Number(historyPopupWheelScroll.tooltipOpenEntryState.scrollbarZIndex),
    `expanded history entry should paint above the local scrollbar mirror: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.rowOpacity,
    '1',
    `dimmed history row should use full opacity while hovered and expanded: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.match(
    historyPopupWheelScroll.tooltipOpenEntryState.backgroundColor,
    /^(rgb|color)\(/,
    `expanded history entry should use an opaque background: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.doesNotMatch(
    historyPopupWheelScroll.tooltipOpenEntryState.backgroundColor,
    /rgba\([^)]*, 0\.\d+\)/,
    `expanded history entry background should not let content underneath show through: ${JSON.stringify(historyPopupWheelScroll)}`
  )
	  assert.ok(
	    historyPopupWheelScroll.expandedOnlyHitTarget.visualText.includes('Low score history item'),
	    `expanded history entry should remain visually rendered outside the original history pane: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.expandedOnlyHitTarget.hitInsideExpanded,
	    false,
	    `expanded history entry should stay pointer-transparent so wheel input reaches the scroll list: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
  assert.equal(
    historyPopupWheelScroll.expandedOnlyClipCheck.hitInsideExpanded,
    true,
    `expanded history entry should remain visibly hit-testable outside the clipped history list when pointer events are enabled for measurement: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterOriginalSlotLeave,
    null,
    `history entry should collapse when the pointer leaves the original entry slot, even inside the grown bounds: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.notEqual(
    historyPopupWheelScroll.target.titleWebkitLineClamp,
    '2',
    `history entry title should use the PageChip fade mask instead of CSS line-clamp ellipsis: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.target.titleMaskImage && historyPopupWheelScroll.target.titleMaskImage !== 'none',
    `truncated history entry title should use a fade mask: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.target.titleHeight > historyPopupWheelScroll.target.titleLineHeight * 1.5,
    `long history entry title should render as two visible lines: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  const historyFaviconHitArea = await measureHistoryEntryExpansionSurfaceHitArea(session)
  assert.ok(historyFaviconHitArea.above?.text.includes('Low score history item'), `hovering the vertical space above the history favicon should expand the entry: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.ok(historyFaviconHitArea.below?.text.includes('Low score history item'), `hovering the vertical space below the history favicon should expand the entry: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.deepEqual(historyFaviconHitArea.aboveTooltipTexts, [], `history entry expansion from favicon padding should not create a tooltip popup: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.deepEqual(historyFaviconHitArea.belowTooltipTexts, [], `history entry expansion from favicon padding should not create a tooltip popup: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.notEqual(
    historyPopupWheelScroll.first.webkitLineClamp,
    '2',
    `expanded history entry should not reuse the clipped row's CSS line clamp: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  const historyExpansionViewportConstrained = historyPopupWheelScroll.first.right >= historyPopupWheelScroll.first.viewportRight - 12
  if (historyExpansionViewportConstrained) {
    assert.ok(
      historyPopupWheelScroll.first.expandedLineCount >= historyPopupWheelScroll.target.titleLineCount,
      `history expansion may add rows only when constrained by the browser viewport edge: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  } else {
    assert.equal(
      historyPopupWheelScroll.first.expandedLineCount,
      historyPopupWheelScroll.target.titleLineCount,
      `history expansion should match the visible history title line count when viewport width allows it: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  }
  const normalizeHistoryLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
  const historyTitleLines = historyPopupWheelScroll.target.titleLineTexts.map(normalizeHistoryLineText).filter(Boolean)
  const historyTooltipLines = historyPopupWheelScroll.first.expandedLineTexts.map(normalizeHistoryLineText).filter(Boolean)
  assert.ok(
    historyTooltipLines.length >= historyTitleLines.length,
    `history expansion should keep at least the visible title line rows: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  for (let index = 0; index < historyTitleLines.length - 1; index += 1) {
    assert.equal(
      historyTooltipLines[index],
      historyTitleLines[index],
      `history expansion should preserve visible line breaks before the tail row: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  }
  assert.ok(
    historyTooltipLines[historyTitleLines.length - 1]?.startsWith(historyTitleLines[historyTitleLines.length - 1]),
    `history expansion tail row should start with the same visible text before revealing more: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    (historyPopupWheelScroll.first.titleWidth || 0) > historyPopupWheelScroll.target.titleWidthExact + 8,
    `history expansion title should expand beyond the clipped visible title width: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  if (!historyExpansionViewportConstrained) {
    assert.ok(
      Math.abs((historyPopupWheelScroll.first.titleHeight || 0) - historyPopupWheelScroll.target.titleHeight) <= 1,
      `history expansion should keep the same two-line flow as the visible title when it can expand: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  }
	  assert.ok(
	    historyPopupWheelScroll.target.listScrollHeight > historyPopupWheelScroll.target.listClientHeight,
	    `history panel should be scrollable for popup-wheel check: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideHistoryList,
	    true,
	    `expanded history entry should stay in the native scroll-list ancestry: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsidePanel,
	    true,
	    `expanded history entry should remain parented to the history panel instead of a portal layer: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideDashboardShell,
	    true,
	    `expanded history entry should still stay within the dashboard shell: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideOverlay,
	    false,
	    `expanded history entry should not rely on a sibling overlay for wheel scrolling: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.ok(
	    historyPopupWheelScroll.wheelDeltaY > 0
	      ? historyPopupWheelScroll.after.historyScrollTop > historyPopupWheelScroll.beforeScrollTop.historyScrollTop
      : historyPopupWheelScroll.after.historyScrollTop < historyPopupWheelScroll.beforeScrollTop.historyScrollTop,
    `repeated wheel input over an expanded history entry should keep scrolling the history panel: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.dashboardScrollTop,
    historyPopupWheelScroll.beforeScrollTop.dashboardScrollTop,
    `wheel input over an expanded history entry should not scroll the dashboard pane first: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.expansionCount,
    0,
    `history expansion should close after wheel input scrolls the history panel: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.tooltipCount,
    0,
    `history expansion should not leave a tooltip popup after wheel input: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveExpansionState.expansionCount,
    0,
    `history expansion should stay closed after the pointer leaves the wheel-scrolled entry: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveExpansionState.tooltipCount,
    0,
    `history expansion should not leave a tooltip popup after pointer leave: ${JSON.stringify(historyPopupWheelScroll)}`
  )

  const windowBlurTooltip = await measureTooltipWindowBlurClose(session)
  assert.ok(windowBlurTooltip.first, `page chip should expand before window-blur check: ${JSON.stringify(windowBlurTooltip)}`)
  assert.deepEqual(windowBlurTooltip.afterBlurTooltips, [], `page chip expansion should close when the window loses focus: ${JSON.stringify(windowBlurTooltip)}`)

  const visibilityTooltip = await measureTooltipVisibilityChangeClose(session)
  assert.ok(visibilityTooltip.first, `page chip should expand before visibility-change check: ${JSON.stringify(visibilityTooltip)}`)
  assert.deepEqual(
    visibilityTooltip.afterVisibilityChangeTooltips,
    [],
    `page chip expansion should close synchronously when the page becomes hidden: ${JSON.stringify(visibilityTooltip)}`
  )

  const actionTooltip = await measureActionTooltipClickClose(session)
  assert.ok(actionTooltip.first, `pin tooltip should open before click-close check: ${JSON.stringify(actionTooltip)}`)
  assert.equal(actionTooltip.focusedAfterLeave, true, `pin button should keep focus after click so this smoke covers pointer-focus behavior: ${JSON.stringify(actionTooltip)}`)
  assert.deepEqual(actionTooltip.afterLeaveTooltips, [], `pin tooltip should close after click when the pointer leaves the focused button: ${JSON.stringify(actionTooltip)}`)

  const pageChipReturnTooltip = await measureInteractiveTooltipClickReturnFocus(
    session,
    '.page-chip .chip-text',
    PAGE_CHIP_EXPANSION_SMOKE_LABEL,
    'page-chip',
    '.chip-text'
  )
  assert.ok(pageChipReturnTooltip.first.found, `page chip should expand before click-return check: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.active, true, `page chip should be refocused during click-return smoke test: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.focusVisible, false, `page chip click-return focus should not be keyboard-visible focus: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.deepEqual(pageChipReturnTooltip.afterReturnTooltips, [], `page chip expansion should not leave a tooltip popup after pointer-click return focus: ${JSON.stringify(pageChipReturnTooltip)}`)

  const markerHandoff = await measureMarkerToChipTooltipHandoff(session)
  assert.ok(markerHandoff.target.markerText.startsWith('/'), `strip indicator should render compact path marker text in the chip: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.markerTooltip.found, `strip indicator hover should expand the page chip first: ${JSON.stringify(markerHandoff)}`)
  assert.ok(
    markerHandoff.markerTooltip.expansion?.text.includes('dev2') &&
      markerHandoff.markerTooltip.expansion?.text.includes('Hover Handoff Title'),
    `strip indicator should use chip-level in-place expansion instead of a marker-only tooltip: ${JSON.stringify(markerHandoff)}`
  )
  assert.deepEqual(markerHandoff.markerTooltip.tooltips, [], `strip indicator hover should not create a tooltip popup: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.chipTooltip.found, `page chip should remain expanded after moving from the strip indicator to chip text: ${JSON.stringify(markerHandoff)}`)

  const edgeTooltip = await measureTooltipEdgeFlip(session)
  assert.ok(edgeTooltip.first, `page chip should expand near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  assert.equal(edgeTooltip.first.visibleTooltipCount, 0, `viewport-edge page chip expansion should not create a tooltip popup: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(edgeTooltip.first.right <= edgeTooltip.target.viewportRight - 12, `expanded page chip should keep viewport collision padding near the text edge: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(Math.abs(edgeTooltip.first.textLeft - edgeTooltip.target.textLeft) <= 1, `expanded page chip should preserve the original text origin near the viewport edge: ${JSON.stringify(edgeTooltip)}`)

  const compactTitleVariantExpansion = await measureCompactTitleVariantExpansion(session)
  assert.ok(compactTitleVariantExpansion.expansion, `compact same-title variant chip should expand in place: ${JSON.stringify(compactTitleVariantExpansion)}`)
  assert.ok(
    compactTitleVariantExpansion.expansion.width <= Math.max(
      compactTitleVariantExpansion.target.chipWidth,
      compactTitleVariantExpansion.target.contentWidth + 72
    ) + 1,
    `compact same-title variant chip should not grow beyond its resting width/content budget when the content is short: ${JSON.stringify(compactTitleVariantExpansion)}`
  )
  assert.ok(
    compactTitleVariantExpansion.expansion.width >= compactTitleVariantExpansion.target.chipWidth - 1,
    `compact same-title variant chip expansion should not shrink below its resting chip width: ${JSON.stringify(compactTitleVariantExpansion)}`
  )
  assert.ok(
    compactTitleVariantExpansion.expandedVariantLabels.every((label: { clientWidth: number; scrollWidth: number }) => label.scrollWidth - label.clientWidth <= 1),
    `compact same-title variant chip expansion should keep its URL variant labels untruncated when viewport room allows: ${JSON.stringify(compactTitleVariantExpansion)}`
  )

  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddPathGroupPlaceholderTabs?.()`
  })
  const oneLinePathGroupPlaceholderTooltip = await measurePageChipTooltipLineCount(session, 'at story/ABC-123_2', {
    forcedTextWidth: 130,
    forcedMaxLines: 1,
    hoverWaitMs: 40,
    viewportWidth: 2200
  })
  assert.ok(oneLinePathGroupPlaceholderTooltip.tooltip, `one-line path-group placeholder tooltip should open: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`)
  assert.equal(
    oneLinePathGroupPlaceholderTooltip.target.chipLineCount,
    1,
    `one-line path-group placeholder smoke target should render as one visible chip line: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`
  )
  assert.equal(
    oneLinePathGroupPlaceholderTooltip.tooltip.tooltipLineCount,
    1,
    `one-line path-group placeholder tooltip should widen enough to stay on one line: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`
  )

  const largeBookmarks = await measureLargeBookmarkProgressiveRender(session)
  assert.ok(largeBookmarks.initial, `bookmark source should render an initial progressive chunk: ${JSON.stringify(largeBookmarks)}`)
  assert.ok(largeBookmarks.initial.count <= 24, `bookmark source should not mount all large-list cards in the first chunk: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.initial.measureNodeCount, 0, `large bookmark switch should not create hidden page-chip measure nodes initially: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.final.count, 1008, `large bookmark source should eventually render every synthetic bookmark card: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.final.measureNodeCount, 0, `large bookmark source should not create hidden page-chip measure nodes after all chunks render: ${JSON.stringify(largeBookmarks)}`)
})

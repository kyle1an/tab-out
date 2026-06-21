import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WATCH_TARGETS = ['src', 'extension/base.css', 'extension/style.css', 'package.json', 'scripts/write-manifest.ts', 'vite.config.ts']
const DEBOUNCE_MS = 120
const POLL_MS = 700

let pending = false
let building = false
let buildProcess = null
let debounceTimer = null
let lastSnapshot = snapshotFiles()

function runBuild(reason = 'initial') {
  if (building) {
    pending = true
    return
  }

  building = true
  pending = false
  console.log(`\n[watch] build started (${reason})`)

  buildProcess = spawn('pnpm', ['build'], {
    stdio: 'inherit',
    env: process.env
  })

  buildProcess.on('exit', (code, signal) => {
    building = false
    buildProcess = null

    if (signal) {
      console.log(`[watch] build stopped by ${signal}`)
    } else if (code === 0) {
      console.log('[watch] build completed')
    } else {
      console.log(`[watch] build failed with exit code ${code}`)
    }

    if (pending) runBuild('queued changes')
  })
}

function scheduleBuild(reason) {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => runBuild(reason), DEBOUNCE_MS)
}

function snapshotFiles() {
  const snapshot = new Map()

  for (const target of WATCH_TARGETS) {
    collectFileSnapshot(target, snapshot)
  }

  return snapshot
}

function collectFileSnapshot(target, snapshot) {
  let stat

  try {
    stat = statSync(target)
  } catch {
    snapshot.set(target, 'missing')
    return
  }

  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) {
      collectFileSnapshot(join(target, entry), snapshot)
    }
    return
  }

  if (stat.isFile()) {
    snapshot.set(target, `${stat.mtimeMs}:${stat.size}`)
  }
}

function findChangedPaths(previous, next) {
  const changed = []
  const paths = new Set([...previous.keys(), ...next.keys()])

  for (const path of paths) {
    if (previous.get(path) !== next.get(path)) {
      changed.push(path)
    }
  }

  return changed
}

const pollTimer = setInterval(() => {
  const nextSnapshot = snapshotFiles()
  const changedPaths = findChangedPaths(lastSnapshot, nextSnapshot)

  if (changedPaths.length > 0) {
    lastSnapshot = nextSnapshot
    scheduleBuild(changedPaths.slice(0, 3).join(', '))
  }
}, POLL_MS)

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
  clearTimeout(debounceTimer)
  clearInterval(pollTimer)
  if (buildProcess) buildProcess.kill('SIGTERM')
  process.exit(0)
}

console.log(`[watch] watching ${WATCH_TARGETS.join(', ')}`)
runBuild()

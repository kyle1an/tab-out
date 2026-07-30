import { spawn, type ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'

type WatchTarget = {
  path: string
  filenames?: ReadonlySet<string>
  recursive?: boolean
}

const WATCH_TARGETS: WatchTarget[] = [
  { path: 'src', recursive: true },
  { path: '.', filenames: new Set(['chrome-support.json', 'package.json', 'vite.config.ts']) },
  { path: 'extension', filenames: new Set(['base.css']) },
  { path: 'scripts', filenames: new Set(['build-extension.ts']) }
]
const DEBOUNCE_MS = 120

let pending = false
let building = false
let buildProcess: ChildProcess | null = null
let debounceTimer: ReturnType<typeof setTimeout> | undefined

function runBuild(reason = 'initial'): void {
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
    if (signal) console.log(`[watch] build stopped by ${signal}`)
    else if (code === 0) console.log('[watch] build completed')
    else console.log(`[watch] build failed with exit code ${code}`)
    if (pending) runBuild('queued changes')
  })
}

function scheduleBuild(reason: string): void {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => runBuild(reason), DEBOUNCE_MS)
}

const watchers: FSWatcher[] = WATCH_TARGETS.map(({ path, filenames, recursive = false }) => (
  watch(path, { recursive }, (_event, filename) => {
    const changedPath = filename?.toString()
    if (filenames && (!changedPath || !filenames.has(changedPath))) return
    scheduleBuild(changedPath ? `${path}/${changedPath}` : path)
  })
))

function shutdown(): void {
  clearTimeout(debounceTimer)
  for (const watcher of watchers) watcher.close()
  if (buildProcess) buildProcess.kill('SIGTERM')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`[watch] watching ${WATCH_TARGETS.map(({ path }) => path).join(', ')}`)
runBuild()

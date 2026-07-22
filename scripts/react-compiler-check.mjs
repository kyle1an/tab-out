/* ================================================================
   React Compiler coverage gate — fails `pnpm verify` when a source
   file gains a compiler bailout beyond the known-by-design baseline
   below. The 2026-07-14 React audit restored compilation
   on the hot path; this keeps future edits from silently un-compiling
   it (a bailed component loses ALL auto-memoization, not one memo).

   When a bailout is deliberate (documented ref architecture etc.),
   add it to BASELINE with a reason. When this script reports fewer
   bailouts than the baseline, ratchet the baseline down.
   ================================================================ */

import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const REPO = resolve(import.meta.dirname, '..')

// file (repo-relative) -> expected CompileError count
const BASELINE = new Map([
  ['src/components/App.tsx', 1], // deliberate ordering-cache ref read in render
  ['src/components/title-expansion/use-title-expansion.ts', 1], // lazy-init ref facade (stable return)
  ['src/components/ui/tooltip.tsx', 3], // mergeRefs composition (documented suppressions)
  ['src/extension/layout.ts', 2], // latest-ref render writes; returns are manual useCallbacks
  ['src/hooks/useDashboardRefresh.ts', 1] // try/finally + latest-callback architecture; return is a manual useCallback
])

const repoRequire = createRequire(join(REPO, 'package.json'))
const compiler = repoRequire('babel-plugin-react-compiler')
let babel
try {
  babel = repoRequire('@babel/core')
} catch {
  babel = createRequire(repoRequire.resolve('@rolldown/plugin-babel'))('@babel/core')
}

function sourceFiles() {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(tsx|ts)$/.test(name) && !name.endsWith('.d.ts')) files.push(path)
    }
  }
  walk(join(REPO, 'src'))
  return files
}

function bailoutsForFile(file) {
  const errors = []
  try {
    babel.transformSync(readFileSync(file, 'utf8'), {
      filename: file,
      babelrc: false,
      configFile: false,
      code: false,
      parserOpts: { plugins: ['typescript', 'jsx'] },
      plugins: [
        [
          compiler,
          {
            panicThreshold: 'none',
            logger: {
              logEvent(_filename, event) {
                if (event.kind === 'CompileError') {
                  errors.push(`fn@${event.fnLoc?.start?.line ?? '?'}: ${event.detail?.reason ?? 'unknown reason'}`)
                }
              }
            }
          }
        ]
      ]
    })
  } catch (error) {
    errors.push(`pipeline error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  return errors
}

const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f)) : sourceFiles()

const regressions = []
const improvements = []
let totalBailouts = 0

for (const file of files) {
  const rel = relative(REPO, file)
  const errors = bailoutsForFile(file)
  totalBailouts += errors.length
  const expected = BASELINE.get(rel) ?? 0
  if (errors.length > expected) {
    regressions.push({ rel, expected, errors })
  } else if (errors.length < expected) {
    improvements.push({ rel, expected, actual: errors.length })
  }
}

if (regressions.length > 0) {
  console.error('React Compiler coverage regressed — new bailouts beyond the known-by-design baseline:\n')
  for (const { rel, expected, errors } of regressions) {
    console.error(`  ${rel} (expected ${expected}, got ${errors.length}):`)
    for (const error of errors) console.error(`    ${error}`)
  }
  console.error('\nFix the bailout using the existing stable-return and suppression patterns or, if deliberate and documented, update the baseline in scripts/react-compiler-check.mjs.')
  process.exit(1)
}

const summary = `react-compiler-check: ${totalBailouts} bailout${totalBailouts === 1 ? '' : 's'} across ${files.length} files — all within baseline`
if (improvements.length > 0) {
  console.log(`${summary}; baseline can ratchet down: ${improvements.map(({ rel, expected, actual }) => `${rel} ${expected}→${actual}`).join(', ')}`)
} else {
  console.log(summary)
}

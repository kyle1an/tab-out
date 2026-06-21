import { spawnSync } from 'node:child_process'

const viteArgs = process.argv.slice(2)

const manifestResult = spawnSync('pnpm', ['exec', 'tsx', 'scripts/write-manifest.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

if (manifestResult.status !== 0) {
  process.exit(manifestResult.status ?? 1)
}

function runBuild(entry) {
  const result = spawnSync('pnpm', ['exec', 'vite', 'build', ...viteArgs], {
    env: { ...process.env, TAB_OUT_BUILD_ENTRY: entry },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runBuild('app')
runBuild('background')

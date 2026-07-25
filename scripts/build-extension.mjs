import { spawnSync } from 'node:child_process'

const viteArgs = process.argv.slice(2)

function runGenerator(script, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, '--import', 'tsx', script], {
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runGenerator('scripts/write-manifest.ts')
runGenerator('scripts/write-index-html.ts', ['--experimental-import-text'])

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

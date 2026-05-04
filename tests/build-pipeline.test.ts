import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

test('extension HTML loads the Vite-built React entry', () => {
  assert.ok(existsSync('package.json'), 'package.json should define the Vite build')
  assert.ok(existsSync('src/app.tsx'), 'src/app.tsx should be the React entry source')
  assert.ok(existsSync('src/extension/background.ts'), 'src/extension/background.ts should be the service worker source')

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'))
  assert.match(pkg.packageManager, /^pnpm@/)
  assert.equal(pkg.scripts?.['setup:hooks'], 'git config core.hooksPath .githooks')
  assert.equal(pkg.scripts?.dev, 'vite build --watch')
  assert.equal(pkg.scripts?.build, 'vite build')
  assert.equal(pkg.scripts?.['build:debug'], 'vite build --sourcemap')
  assert.equal(pkg.scripts?.lint, 'eslint . --max-warnings=0')
  assert.match(pkg.scripts?.['test:browser'], /RUN_BROWSER_SMOKE=1/)
  assert.equal(pkg.scripts?.['verify:bundle'], 'git diff --exit-code -- extension/dist')
  assert.match(pkg.scripts?.verify, /pnpm lint/)
  assert.match(pkg.scripts?.verify, /pnpm verify:bundle/)
  assert.match(pkg.scripts?.['verify:browser'], /pnpm test:browser/)
  assert.ok(pkg.dependencies?.react)
  assert.ok(pkg.dependencies?.['react-dom'])
  assert.ok(pkg.dependencies?.['@base-ui/react'])
  assert.ok(pkg.devDependencies?.['@types/chrome'])
  assert.ok(pkg.devDependencies?.['@rolldown/plugin-babel'])
  assert.ok(pkg.devDependencies?.['babel-plugin-react-compiler'])
  assert.ok(pkg.devDependencies?.vite)
  assert.ok(tsconfig.compilerOptions?.types?.includes('chrome'))
  assert.equal(tsconfig.compilerOptions?.allowJs, false)
  assert.equal(tsconfig.compilerOptions?.noImplicitAny, true)
  assert.equal(tsconfig.compilerOptions?.strictNullChecks, true)

  const indexHtml = readFileSync('extension/index.html', 'utf8')
  assert.match(indexHtml, /src="dist\/app\.js"/)
  assert.doesNotMatch(indexHtml, /src="app\.js"/)

  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))
  assert.equal(manifest.background?.service_worker, 'dist/background.js')

  const viteConfig = readFileSync('vite.config.ts', 'utf8')
  assert.match(viteConfig, /reactCompilerPreset/)
  assert.match(viteConfig, /@rolldown\/plugin-babel/)
  assert.match(viteConfig, /src\/extension\/background\.ts/)

  const appSource = readFileSync('src/app.tsx', 'utf8')
  const appComponentSource = readFileSync('src/components/App.tsx', 'utf8')
  const toastSource = readFileSync('src/components/Toast.tsx', 'utf8')
  const segmentedTabsSource = readFileSync('src/components/ui/SegmentedTabs.tsx', 'utf8')
  const sharedTypesSource = readFileSync('src/extension/types.d.ts', 'utf8')
  assert.match(`${appComponentSource}\n${toastSource}`, /react-dom\/client/)
  assert.match(segmentedTabsSource, /@base-ui\/react\/tabs/)
  assert.doesNotMatch(`${appSource}\n${appComponentSource}\n${toastSource}`, /vendor\/preact|vendor\/htm/)
  assert.doesNotMatch(sharedTypesSource, /const chrome:\s*any/)
  assert.doesNotMatch(sharedTypesSource, /LOCAL_PATH_GROUPERS\?:\s*any\[\]/)
})

test('repo pre-commit hook runs the verification pipeline', () => {
  assert.ok(existsSync('.githooks/pre-commit'), 'pre-commit hook should be committed for local setup')

  const hook = readFileSync('.githooks/pre-commit', 'utf8')
  assert.match(hook, /^#!\/bin\/sh/)
  assert.match(hook, /pnpm verify/)
})

test('built extension bundle is packaged locally', () => {
  assert.ok(existsSync('extension/dist/app.js'), 'extension/dist/app.js should be committed build output for unpacked extension loading')
  assert.ok(existsSync('extension/dist/background.js'), 'extension/dist/background.js should be committed service worker output')
  assert.equal(existsSync('extension/dist/app.js.map'), false, 'production build should not ship a sourcemap')
  assert.equal(existsSync('extension/dist/background.js.map'), false, 'production build should not ship a service-worker sourcemap')
  assert.equal(existsSync('extension/dist/chunks'), false, 'dashboard UI should be bundled into one JS entry')

  const distFiles = readdirSync('extension/dist').sort()
  assert.deepEqual(distFiles, ['app.js', 'background.js'])
  assert.deepEqual(readdirSync('extension').filter((name) => name.endsWith('.js')), ['config.local.js'])

  const bundle = readFileSync('extension/dist/app.js', 'utf8')
  const backgroundBundle = readFileSync('extension/dist/background.js', 'utf8')
  assert.doesNotMatch(bundle, /from\s+['"]https?:\/\//)
  assert.doesNotMatch(backgroundBundle, /from\s+['"]https?:\/\//)
  assert.doesNotMatch(bundle, /vendor\/preact|vendor\/htm/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('automatic toast and source-switch motion honor reduced-motion preferences', () => {
  const toast = readFileSync(new URL('../src/components/Toast.tsx', import.meta.url), 'utf8')
  const header = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')

  assert.match(toast, /motion-reduce:data-starting-style:transform-none/)
  assert.match(toast, /motion-reduce:data-ending-style:transform-none/)
  assert.match(header, /source-switch-indicator[^"\n]*motion-reduce:transition-none/)
})

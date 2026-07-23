import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('hidden section actions become visible with an amber keyboard focus ring', () => {
  for (const sourcePath of [
    '../src/components/SectionPinButton.tsx',
    '../src/components/SubdomainSection.tsx',
    '../src/components/WebsitePathSection.tsx',
    '../src/components/PathgroupSection.tsx'
  ]) {
    const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8')
    assert.match(source, /focus-visible:opacity-100/)
    assert.match(source, /focus-visible:outline-\(--accent-amber\)/)
  }
})

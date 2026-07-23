import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('mission rendering parses one immutable filter highlight set for all Page Chips', () => {
  const missions = readFileSync(new URL('../src/components/Missions.tsx', import.meta.url), 'utf8')
  const domainCard = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const pageChip = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(missions, /const highlightTerms = highlightTermsForFilter\(filter\)/)
  assert.match(missions, /<DomainCard[\s\S]*highlightTerms=\{highlightTerms\}/)
  assert.match(domainCard, /highlightTerms: highlightTerms \?\? null/)
  assert.match(pageChip, /cardHighlightTerms \?\? highlightTermsForFilter\(filter\)/)
})

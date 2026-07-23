import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareDependencyBaselines,
  type DependencyBaselineViolation
} from '../scripts/check-dependency-architecture.js'

function violation(from: string, to: string): DependencyBaselineViolation {
  return {
    type: 'dependency',
    from,
    to,
    rule: {
      severity: 'error',
      name: 'example-rule'
    }
  }
}

test('dependency baseline comparison reports new violations and stale exemptions', () => {
  const unchanged = violation('src/unchanged.ts', 'src/shared.ts')
  const unchangedWithCurrentMetadata = {
    ...unchanged,
    dependencyTypes: ['local', 'type-only', 'type-import']
  }
  const unexpected = violation('src/new.ts', 'src/shared.ts')
  const stale = violation('src/resolved.ts', 'src/shared.ts')

  assert.deepEqual(
    compareDependencyBaselines([unchangedWithCurrentMetadata, unexpected], [unchanged, stale]),
    {
      unexpected: [unexpected],
      stale: [stale]
    }
  )
})

test('dependency baseline comparison identifies cycles by rule and cycle members', () => {
  const knownCycle: DependencyBaselineViolation = {
    ...violation('src/a.ts', 'src/b.ts'),
    type: 'cycle',
    rule: { severity: 'error', name: 'no-circular' },
    cycle: [{ name: 'src/a.ts' }, { name: 'src/b.ts' }]
  }
  const currentCycle: DependencyBaselineViolation = {
    ...violation('src/b.ts', 'src/a.ts'),
    type: 'cycle',
    rule: { severity: 'error', name: 'no-circular' },
    cycle: [
      { name: 'src/b.ts', dependencyTypes: ['local', 'type-import'] },
      { name: 'src/a.ts', dependencyTypes: ['local', 'import'] }
    ]
  }

  assert.deepEqual(compareDependencyBaselines([currentCycle], [knownCycle]), {
    unexpected: [],
    stale: []
  })
})

test('dependency baseline comparison identifies via paths independently of metadata order', () => {
  const knownVia: DependencyBaselineViolation = {
    ...violation('src/entry.ts', 'node:fs'),
    via: [{ name: 'src/a.ts' }, { name: 'src/b.ts' }]
  }
  const currentVia: DependencyBaselineViolation = {
    ...violation('src/entry.ts', 'node:fs'),
    via: [
      { name: 'src/b.ts', dependencyTypes: ['local', 'type-import'] },
      { name: 'src/a.ts', dependencyTypes: ['local', 'import'] }
    ]
  }

  assert.deepEqual(compareDependencyBaselines([currentVia], [knownVia]), {
    unexpected: [],
    stale: []
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeLocalCustomGroups,
  normalizeLocalPathGroupers,
  normalizeLocalUrlCanonicalizers,
  readLocalCustomGroups,
  type LocalConfigWarning
} from '../src/extension/local-config.js'
import { resolvePathGroup } from '../src/extension/path-groups.js'

type TestGlobal = typeof globalThis & {
  window?: Window & typeof globalThis
}

function withWindow<T>(windowValue: Partial<Window>, fn: () => T): T {
  const testGlobal = globalThis as TestGlobal
  const previousWindow = testGlobal.window
  testGlobal.window = windowValue as Window & typeof globalThis
  try {
    return fn()
  } finally {
    if (previousWindow === undefined) {
      delete testGlobal.window
    } else {
      testGlobal.window = previousWindow
    }
  }
}

function withoutConsoleWarn<T>(fn: () => T): T {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = originalWarn
  }
}

test('normalizeLocalCustomGroups keeps valid rules and trims string fields', () => {
  const warnings: LocalConfigWarning[] = []
  const rules = normalizeLocalCustomGroups([
    {
      hostname: ' example.com ',
      pathPrefix: ' /docs ',
      groupKey: ' docs ',
      groupLabel: ' Docs '
    },
    {
      hostnameEndsWith: '.example.test',
      groupKey: 'workspace',
      groupLabel: 'Workspace'
    }
  ], warnings)

  assert.deepEqual(rules, [
    {
      hostname: 'example.com',
      pathPrefix: '/docs',
      groupKey: 'docs',
      groupLabel: 'Docs'
    },
    {
      hostnameEndsWith: '.example.test',
      groupKey: 'workspace',
      groupLabel: 'Workspace'
    }
  ])
  assert.deepEqual(warnings, [])
})

test('normalizeLocalCustomGroups filters invalid and mixed local rules', () => {
  const warnings: LocalConfigWarning[] = []
  const rules = normalizeLocalCustomGroups([
    {
      hostname: 'example.com',
      groupKey: 'example',
      groupLabel: 'Example'
    },
    {
      hostname: 'example.test',
      groupKey: '',
      groupLabel: 'Missing key'
    },
    {
      groupKey: 'missing-host',
      groupLabel: 'Missing host'
    },
    null,
    'not-a-rule',
    {
      hostnameEndsWith: '.example.org',
      groupKey: 'org',
      groupLabel: 'Example Org'
    }
  ], warnings)

  assert.deepEqual(rules, [
    {
      hostname: 'example.com',
      groupKey: 'example',
      groupLabel: 'Example'
    },
    {
      hostnameEndsWith: '.example.org',
      groupKey: 'org',
      groupLabel: 'Example Org'
    }
  ])
  assert.deepEqual(warnings.map((warning) => warning.index), [1, 2, 3, 4])
})

test('normalizeLocalCustomGroups preserves duplicate valid rules in order', () => {
  const rule = {
    hostname: 'example.com',
    groupKey: 'example',
    groupLabel: 'Example'
  }

  assert.deepEqual(normalizeLocalCustomGroups([rule, rule]), [rule, rule])
})

test('normalizeLocalCustomGroups ignores non-array values with a source warning', () => {
  const warnings: LocalConfigWarning[] = []

  assert.deepEqual(normalizeLocalCustomGroups({ hostname: 'example.com' }, warnings), [])
  assert.deepEqual(warnings, [
    {
      source: 'LOCAL_CUSTOM_GROUPS',
      index: null,
      reason: 'expected an array'
    }
  ])
})

test('readLocalCustomGroups normalizes window config and warns once for invalid rules', () => {
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    withWindow({
      LOCAL_CUSTOM_GROUPS: [
        {
          hostname: 'example.com',
          groupKey: 'example',
          groupLabel: 'Example'
        },
        {
          hostname: 'example.test',
          groupKey: '',
          groupLabel: 'Invalid'
        }
      ],
      LOCAL_PATH_GROUPERS: []
    }, () => {
      assert.equal(readLocalCustomGroups().length, 1)
      assert.equal(readLocalCustomGroups().length, 1)
    })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.[0], 'Tab Out ignored an invalid local config rule.')
})

test('normalizeLocalPathGroupers keeps valid data rules and wraps extract results', () => {
  const warnings: LocalConfigWarning[] = []
  const rules = normalizeLocalPathGroupers([
    {
      hostname: 'example.com',
      extract: (url: URL) => ({ key: url.pathname.slice(1), label: 'Example Path' })
    }
  ], warnings)

  assert.equal(rules.length, 1)
  assert.deepEqual(rules[0]?.extract(new URL('https://example.com/docs')), {
    key: 'docs',
    label: 'Example Path'
  })
  assert.deepEqual(warnings, [])
})

test('normalizeLocalPathGroupers filters invalid and mixed local rules', () => {
  const warnings: LocalConfigWarning[] = []
  const rules = normalizeLocalPathGroupers([
    {
      hostname: 'example.com',
      extract: () => ({ key: 'valid', label: 'Valid' })
    },
    {
      hostname: 'example.test',
      extract: 'not-a-function'
    },
    {
      groupKey: 'wrong-shape',
      extract: () => ({ key: 'wrong', label: 'Wrong' })
    },
    null
  ], warnings)

  assert.equal(rules.length, 1)
  assert.deepEqual(warnings.map((warning) => warning.index), [1, 2, 3])
})

test('normalizeLocalPathGroupers ignores non-array values with a source warning', () => {
  const warnings: LocalConfigWarning[] = []

  assert.deepEqual(normalizeLocalPathGroupers({ hostname: 'example.com' }, warnings), [])
  assert.deepEqual(warnings, [
    {
      source: 'LOCAL_PATH_GROUPERS',
      index: null,
      reason: 'expected an array'
    }
  ])
})

test('normalizeLocalPathGroupers treats duplicate rules as ordered overrides', () => {
  const firstRule = {
    hostname: 'example.com',
    extract: () => ({ key: 'first', label: 'First' })
  }
  const secondRule = {
    hostname: 'example.com',
    extract: () => ({ key: 'second', label: 'Second' })
  }
  const rules = normalizeLocalPathGroupers([firstRule, secondRule])

  assert.equal(rules.length, 2)
  assert.equal(rules[0]?.extract(new URL('https://example.com/'))?.key, 'first')
  assert.equal(rules[1]?.extract(new URL('https://example.com/'))?.key, 'second')
})

test('normalizeLocalPathGroupers returns null for throwing rules and invalid results', () => {
  const rules = normalizeLocalPathGroupers([
    {
      hostname: 'example.com',
      extract: () => ({ key: '', label: 'Invalid' })
    },
    {
      hostname: 'example.com',
      extract: () => {
        throw new Error('bad local rule')
      }
    }
  ])

  withoutConsoleWarn(() => {
    assert.equal(rules[0]?.extract(new URL('https://example.com/docs')), null)
    assert.equal(rules[1]?.extract(new URL('https://example.com/docs')), null)
  })
})

test('resolvePathGroup still runs built-ins after invalid local path groupers', () => {
  withoutConsoleWarn(() => {
    withWindow({
      LOCAL_CUSTOM_GROUPS: [],
      LOCAL_PATH_GROUPERS: [
        {
          hostname: 'github.com',
          extract: () => {
            throw new Error('bad local rule')
          }
        }
      ]
    }, () => {
      assert.deepEqual(resolvePathGroup('https://github.com/example-org/example-repo/pull/123'), {
        key: 'example-org/example-repo',
        label: 'example-org/example-repo',
        category: 'pull'
      })
    })
  })
})

test('normalizeLocalUrlCanonicalizers keeps valid data rules and wraps canonicalize results', () => {
  const warnings: LocalConfigWarning[] = []
  const rules = normalizeLocalUrlCanonicalizers([
    {
      hostname: 'example.com',
      canonicalize: (url: URL) => `${url.origin}/canonical`
    }
  ], warnings)

  assert.equal(rules.length, 1)
  assert.equal(rules[0]?.canonicalize(new URL('https://example.com/x?y=1')), 'https://example.com/canonical')
  assert.deepEqual(warnings, [])
})

test('normalizeLocalUrlCanonicalizers filters invalid and mixed local rules', () => {
  const warnings: LocalConfigWarning[] = []
  const rules = normalizeLocalUrlCanonicalizers([
    { hostname: 'example.com', canonicalize: () => 'https://example.com/ok' },
    { hostname: 'example.test', canonicalize: 'not-a-function' },
    { groupKey: 'wrong-shape', canonicalize: () => 'https://example.org/ok' },
    null
  ], warnings)

  assert.equal(rules.length, 1)
  assert.deepEqual(warnings.map((warning) => warning.index), [1, 2, 3])
})

test('normalizeLocalUrlCanonicalizers ignores non-array values with a source warning', () => {
  const warnings: LocalConfigWarning[] = []

  assert.deepEqual(normalizeLocalUrlCanonicalizers({ hostname: 'example.com' }, warnings), [])
  assert.deepEqual(warnings, [
    { source: 'LOCAL_URL_CANONICALIZERS', index: null, reason: 'expected an array' }
  ])
})

test('normalizeLocalUrlCanonicalizers returns null for throwing rules and invalid results', () => {
  const rules = normalizeLocalUrlCanonicalizers([
    { hostname: 'example.com', canonicalize: () => '' },
    { hostname: 'example.com', canonicalize: () => { throw new Error('bad local rule') } }
  ])

  withoutConsoleWarn(() => {
    assert.equal(rules[0]?.canonicalize(new URL('https://example.com/x')), null)
    assert.equal(rules[1]?.canonicalize(new URL('https://example.com/x')), null)
  })
})

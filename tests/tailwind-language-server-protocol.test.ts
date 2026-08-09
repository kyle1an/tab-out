import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isUnknownRecord,
  parseJsonRpcMessage,
  requireConfigurationParams,
  requirePublishedDiagnosticsParams,
} from '../scripts/tailwind-language-server-protocol.js'

test('validates Tailwind language-server JSON-RPC envelopes', () => {
  assert.deepEqual(
    parseJsonRpcMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'workspace/configuration',
      params: { items: [{ section: 'tailwindCSS.lint' }] },
    })),
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'workspace/configuration',
      params: { items: [{ section: 'tailwindCSS.lint' }] },
    },
  )
  assert.throws(
    () => parseJsonRpcMessage('{"method": 42}'),
    /invalid JSON-RPC message/,
  )
})

test('validates workspace configuration requests before reading their items', () => {
  assert.deepEqual(
    requireConfigurationParams({ items: [{ section: 'tailwindCSS' }, {}] }),
    { items: [{ section: 'tailwindCSS' }, {}] },
  )
  assert.throws(
    () => requireConfigurationParams({ items: [{ section: 42 }] }),
    /invalid workspace configuration parameters/,
  )
})

test('validates published diagnostic locations and messages', () => {
  const params = {
    uri: 'file:///example.tsx',
    diagnostics: [{
      range: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 8 },
      },
      severity: 2,
      code: 'suggestCanonicalClasses',
      message: 'Example diagnostic',
    }],
  }

  assert.deepEqual(requirePublishedDiagnosticsParams(params), params)
  assert.throws(
    () => requirePublishedDiagnosticsParams({
      uri: 'file:///example.tsx',
      diagnostics: [{ range: { start: { line: -1, character: 0 } }, message: 'Invalid' }],
    }),
    /published invalid diagnostics/,
  )
})

test('recognizes only string-keyed records for nested settings lookup', () => {
  assert.equal(isUnknownRecord({ lint: { cssConflict: 'warning' } }), true)
  assert.equal(isUnknownRecord(null), false)
  assert.equal(isUnknownRecord([]), false)
})

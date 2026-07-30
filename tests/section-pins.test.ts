import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPinnedSectionMutation,
  normalizePinnedSections,
  pathgroupPinId,
  subdomainPinId,
  websitePathPinId
} from '../src/extension/section-pins.js'

// === Identity builders ===

test('subdomainPinId produces a stable kind-prefixed identity', () => {
  assert.equal(subdomainPinId('google.com', 'docs'), 'subdomain|google.com|docs')
  assert.equal(subdomainPinId('example.com', ''), 'subdomain|example.com|')
})

test('websitePathPinId encodes domain, subdomain, and path key', () => {
  assert.equal(
    websitePathPinId('google.com', 'docs', '/document'),
    'website-path|google.com|docs|/document'
  )
  assert.equal(
    websitePathPinId('example.com', '', '/api'),
    'website-path|example.com||/api'
  )
})

test('pathgroupPinId distinguishes subdomain-level vs website-path-level parents', () => {
  // Pathgroup nested inside a website-path section
  assert.equal(
    pathgroupPinId('google.com', 'docs', '/document', '/foo'),
    'pathgroup|google.com|docs|/document|/foo'
  )
  // Pathgroup directly under the subdomain — empty website-path slot keeps the
  // identity layout fixed so two pathgroups with the same label but different
  // parents never collide.
  assert.equal(
    pathgroupPinId('google.com', 'docs', '', '/foo'),
    'pathgroup|google.com|docs||/foo'
  )
})

test('section pin identities escape delimiters in arbitrary URL-derived keys', () => {
  const id = websitePathPinId('example.test', '', '/foo|bar')

  assert.equal(id, 'website-path:v2|example.test||/foo%7Cbar')
  assert.deepEqual(normalizePinnedSections([id]), [id])
  assert.deepEqual(applyPinnedSectionMutation([], { type: 'set-pinned', id, pinned: true }), [id])
})

test('section pin identities preserve legacy percent-escaped URL paths', () => {
  assert.equal(
    websitePathPinId('example.test', '', '/foo%20bar'),
    'website-path|example.test||/foo%20bar'
  )
  assert.notEqual(
    websitePathPinId('example.test', '', '/foo|bar'),
    websitePathPinId('example.test', '', '/foo%7Cbar')
  )
})

// === normalizePinnedSections ===

test('normalizePinnedSections returns [] for null/undefined/non-array', () => {
  assert.deepEqual(normalizePinnedSections(undefined), [])
  assert.deepEqual(normalizePinnedSections(null), [])
  assert.deepEqual(normalizePinnedSections('hello'), [])
  assert.deepEqual(normalizePinnedSections(42), [])
})

test('normalizePinnedSections preserves valid ids in input order', () => {
  const input = [
    subdomainPinId('a.com', 'x'),
    websitePathPinId('b.com', '', '/foo'),
    pathgroupPinId('c.com', '', '', '/bar')
  ]
  assert.deepEqual(normalizePinnedSections(input), input)
})

test('normalizePinnedSections dedupes by identity', () => {
  const id = subdomainPinId('a.com', 'x')
  assert.deepEqual(normalizePinnedSections([id, id, id]), [id])
})

test('normalizePinnedSections filters out non-string / empty / unknown-kind entries', () => {
  const valid = subdomainPinId('a.com', 'x')
  const input = [valid, '', null, undefined, 42, 'plainstring', 'bad|kind|x']
  assert.deepEqual(normalizePinnedSections(input), [valid])
})

// === applyPinnedSectionMutation ===

test('applyPinnedSectionMutation adds an absent id', () => {
  const id = subdomainPinId('a.com', 'x')
  assert.deepEqual(applyPinnedSectionMutation([], { type: 'set-pinned', id, pinned: true }), [id])
})

test('applyPinnedSectionMutation removes a present id', () => {
  const id = subdomainPinId('a.com', 'x')
  assert.deepEqual(applyPinnedSectionMutation([id], { type: 'set-pinned', id, pinned: false }), [])
})

test('applyPinnedSectionMutation ignores invalid identities', () => {
  const valid = subdomainPinId('a.com', 'x')
  assert.deepEqual(applyPinnedSectionMutation([valid], { type: 'set-pinned', id: 'bogus', pinned: true }), [valid])
  assert.deepEqual(applyPinnedSectionMutation([valid], { type: 'set-pinned', id: '', pinned: true }), [valid])
})

test('applyPinnedSectionMutation normalizes the existing list before setting', () => {
  const a = subdomainPinId('a.com', 'x')
  const b = subdomainPinId('b.com', '')
  assert.deepEqual(applyPinnedSectionMutation([a, a, 'bogus', undefined], { type: 'set-pinned', id: b, pinned: true }), [a, b])
})

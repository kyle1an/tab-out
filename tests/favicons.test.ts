import assert from 'node:assert/strict'
import test from 'node:test'

import { pickTabFavicon } from '../src/extension/favicons.js'

// Stub Chrome's _favicon URL builder so pickFavicon's recovery path can run
// under node (the real API is provided by the extension runtime at call time).
;(globalThis as unknown as { chrome: { runtime: { getURL(path: string): string } } }).chrome = {
  runtime: { getURL: (path: string) => `chrome-extension://testextensionid${path}` }
}

test('pickTabFavicon: a live tab uses its own favIconUrl', () => {
  assert.equal(
    pickTabFavicon({ favIconUrl: 'https://site.example/icon.png', url: 'https://site.example', suspended: false }),
    'https://site.example/icon.png'
  )
})

test('pickTabFavicon: a suspended tab recovers the real favicon from the unwrapped url', () => {
  const result = pickTabFavicon({ favIconUrl: '', url: 'https://real.example/page', suspended: true })
  assert.match(result, /\/_favicon\/\?pageUrl=https%3A%2F%2Freal\.example%2Fpage&size=32$/)
})

test('pickTabFavicon: a suspended tab replaces the suspender data: favicon with the cache lookup', () => {
  // Suspenders set their page favicon to a faded data: copy of the original,
  // so a suspended tab's own favIconUrl must never win over the cache lookup.
  const result = pickTabFavicon({
    favIconUrl: 'data:image/png;base64,AAAA',
    url: 'https://real.example/page',
    suspended: true
  })
  assert.match(result, /\/_favicon\/\?pageUrl=https%3A%2F%2Freal\.example%2Fpage&size=32$/)
})

test('pickTabFavicon: a suspended tab falls back to its own favicon without the favicon API', () => {
  const globalWithChrome = globalThis as { chrome?: unknown }
  const saved = globalWithChrome.chrome
  delete globalWithChrome.chrome
  try {
    const data = 'data:image/png;base64,AAAA'
    assert.equal(pickTabFavicon({ favIconUrl: data, url: 'https://real.example/page', suspended: true }), data)
  } finally {
    globalWithChrome.chrome = saved
  }
})

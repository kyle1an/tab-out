import assert from 'node:assert/strict'
import test from 'node:test'

import { pickTabFavicon } from '../src/extension/favicons.js'

// Stub Chrome's _favicon URL builder so pickFavicon's recovery path can run
// under node (the real API is provided by the extension runtime at call time).
;(globalThis as unknown as { chrome: { runtime: { getURL(path: string): string } } }).chrome = {
  runtime: { getURL: (path: string) => `chrome-extension://testextensionid${path}` },
}

test('pickTabFavicon: a live tab resolves a remote favicon through the local favicon cache', () => {
  const result = pickTabFavicon({
    favIconUrl: 'https://site.example/icon.png',
    url: 'https://site.example/page',
    suspended: false,
  })
  assert.match(result, /\/_favicon\/\?pageUrl=https%3A%2F%2Fsite\.example%2Fpage&size=32$/)
})

test('pickTabFavicon: a live tab keeps a data: favicon verbatim', () => {
  const data = 'data:image/png;base64,AAAA'
  assert.equal(pickTabFavicon({ favIconUrl: data, url: 'https://site.example/page', suspended: false }), data)
})

test('pickTabFavicon: a live tab falls back to its remote favicon without the favicon API', () => {
  const globalWithChrome = globalThis as { chrome?: unknown }
  const saved = globalWithChrome.chrome
  delete globalWithChrome.chrome
  try {
    assert.equal(
      pickTabFavicon({ favIconUrl: 'https://site.example/icon.png', url: 'https://site.example/page', suspended: false }),
      'https://site.example/icon.png',
    )
  } finally {
    globalWithChrome.chrome = saved
  }
})

test('pickTabFavicon: a live tab without any favicon stays empty', () => {
  assert.equal(pickTabFavicon({ favIconUrl: '', url: 'https://site.example/page', suspended: false }), '')
})

test('pickTabFavicon: a suspended tab recovers the real favicon from the unwrapped url', () => {
  const result = pickTabFavicon({ favIconUrl: '', url: 'https://real.example/page', suspended: true })
  assert.match(result, /\/_favicon\/\?pageUrl=https%3A%2F%2Freal\.example%2Fpage&size=32$/)
})

test('pickTabFavicon: a suspended tab ignores the suspender-faded data: favicon and resolves the original url', () => {
  const result = pickTabFavicon({
    favIconUrl: 'data:image/png;base64,AAAA',
    url: 'https://real.example/page',
    suspended: true,
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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const bootSource = readFileSync(new URL('../extension/dist/filter-focus-boot.js', import.meta.url), 'utf8')

test('filter bootstrap never activates a Chrome window from the page', async () => {
  let windowsApiUsed = false
  let tabsApiUsed = false

  vm.runInNewContext(bootSource, {
    URLSearchParams,
    window: { location: { search: '?focusWindow=1&newPage=1' } },
    document: {
      querySelector: () => null
    },
    chrome: {
      windows: {
        getCurrent: async () => {
          windowsApiUsed = true
        },
        update: async () => {
          windowsApiUsed = true
        }
      },
      tabs: {
        getCurrent: async () => {
          tabsApiUsed = true
        },
        create: async () => {
          tabsApiUsed = true
        },
        remove: async () => {
          tabsApiUsed = true
        }
      }
    }
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(windowsApiUsed, false)
  assert.equal(tabsApiUsed, false)
})

test('filter bootstrap still focuses and seeds the in-page filter', () => {
  const input = {
    value: '',
    focused: false,
    addEventListener() {},
    focus() {
      this.focused = true
    }
  }

  vm.runInNewContext(bootSource, {
    URLSearchParams,
    window: { location: { search: '?focusFilter=1&filter=qa+env' } },
    document: {
      documentElement: { dataset: {} },
      querySelector: () => input
    }
  })

  assert.equal(input.value, 'qa env')
  assert.equal(input.focused, true)
})

test('filter bootstrap seeds a URL query without taking focus', () => {
  const input = {
    value: '',
    focused: false,
    addEventListener() {},
    removeEventListener() {},
    focus() {
      this.focused = true
    }
  }

  vm.runInNewContext(bootSource, {
    URLSearchParams,
    window: { location: { search: '?filter=qa+env' } },
    document: {
      documentElement: { dataset: {} },
      querySelector: () => input
    }
  })

  assert.equal(input.value, 'qa env')
  assert.equal(input.focused, false)
})

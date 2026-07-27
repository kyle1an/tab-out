import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addSavedPageToStore,
  createSavedPagesMutationStore,
  emptySavedPagesStore,
  mergeSavedPagesWithTabs,
  removeSavedPageFromStore,
  type SavedPageCandidate,
  type SavedPagesStore
} from '../src/extension/saved-pages.js'
import type { DashboardTab } from '../src/extension/types'

function cloneStore(store: SavedPagesStore): SavedPagesStore {
  return structuredClone(store)
}

function savedPage(url: string, title: string): SavedPageCandidate {
  return {
    url,
    rawUrl: url,
    title,
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }
}

function openTab(url: string, title: string): DashboardTab {
  return {
    id: 1,
    url,
    rawUrl: url,
    suspended: false,
    title,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false
  }
}

test('serialized Saved Pages mutations preserve a concurrent save after remove and ignore stale render metadata', async () => {
  const removedUrl = 'https://example.test/removed'
  const savedUrl = 'https://example.test/saved'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), savedPage(removedUrl, 'Original title'), 100)
  const staleMetadataStore = mergeSavedPagesWithTabs(
    [openTab(removedUrl, 'Render title')],
    baseStore,
    200
  ).store
  let stored = cloneStore(baseStore)
  let writes = 0
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  let exclusiveQueue = Promise.resolve()
  function runExclusive<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = exclusiveQueue.then(task)
    exclusiveQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const adapter = {
    read: async () => cloneStore(stored),
    write: async (nextStore: SavedPagesStore) => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      stored = cloneStore(nextStore)
    },
    runExclusive
  }
  // Separate mutation-store instances model separate Tab Out pages. Their
  // shared adapter lock is what serializes the cross-context read/write pair.
  const removeMutations = createSavedPagesMutationStore(adapter)
  const saveMutations = createSavedPagesMutationStore(adapter)
  const metadataMutations = createSavedPagesMutationStore(adapter)

  const removePromise = removeMutations.mutate((store) => {
    const result = removeSavedPageFromStore(store, removedUrl)
    return { store: result.store, value: result.removed }
  })
  await firstWriteStarted.promise

  const savePromise = saveMutations.mutate((store) => ({
    store: addSavedPageToStore(store, savedPage(savedUrl, 'New saved page'), 300),
    value: undefined
  }))
  const staleMetadataPromise = metadataMutations.persistMetadataUpdates(baseStore, staleMetadataStore)
  releaseFirstWrite.resolve()

  const [removed] = await Promise.all([removePromise, savePromise, staleMetadataPromise])

  assert.equal(removed?.title, 'Original title')
  assert.equal(stored.pages[removedUrl], undefined)
  assert.equal(stored.pages[savedUrl]?.title, 'New saved page')
  assert.equal(writes, 2, 'the stale metadata pass must not perform a third write')
})

test('stale render metadata cannot overwrite a newer save of the same page', async () => {
  const url = 'https://example.test/article'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), savedPage(url, 'Original title'), 100)
  const staleMetadataStore = mergeSavedPagesWithTabs(
    [openTab(url, 'Stale render title')],
    baseStore,
    200
  ).store
  let stored = cloneStore(baseStore)
  let writes = 0
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  const mutations = createSavedPagesMutationStore({
    read: async () => cloneStore(stored),
    write: async (nextStore) => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      stored = cloneStore(nextStore)
    }
  })

  const savePromise = mutations.mutate((store) => ({
    store: addSavedPageToStore(store, savedPage(url, 'Newest user title'), 300),
    value: undefined
  }))
  await firstWriteStarted.promise
  const staleMetadataPromise = mutations.persistMetadataUpdates(baseStore, staleMetadataStore)
  releaseFirstWrite.resolve()
  await Promise.all([savePromise, staleMetadataPromise])

  assert.equal(stored.pages[url]?.title, 'Newest user title')
  assert.equal(stored.pages[url]?.updatedAt, 300)
  assert.equal(writes, 1, 'the stale metadata pass must not overwrite the newer record')
})

test('a Saved Pages storage read failure aborts before write and does not poison later mutations', async () => {
  const existingUrl = 'https://example.test/existing'
  const nextUrl = 'https://example.test/next'
  let stored = addSavedPageToStore(emptySavedPagesStore(), savedPage(existingUrl, 'Existing'), 100)
  let reads = 0
  let writes = 0
  const mutations = createSavedPagesMutationStore({
    read: async () => {
      reads += 1
      if (reads === 1) throw new Error('storage read failed')
      return cloneStore(stored)
    },
    write: async (nextStore) => {
      writes += 1
      stored = cloneStore(nextStore)
    }
  })

  await assert.rejects(
    mutations.mutate((store) => ({
      store: addSavedPageToStore(store, savedPage(nextUrl, 'Next'), 200),
      value: undefined
    })),
    /storage read failed/
  )

  assert.equal(writes, 0)
  assert.deepEqual(Object.keys(stored.pages), [existingUrl])

  await mutations.mutate((store) => ({
    store: addSavedPageToStore(store, savedPage(nextUrl, 'Next'), 200),
    value: undefined
  }))

  assert.equal(writes, 1)
  assert.deepEqual(Object.keys(stored.pages).sort(), [existingUrl, nextUrl])
})

test('a malformed Saved Pages store aborts mutation instead of erasing it', async () => {
  let writes = 0
  const mutations = createSavedPagesMutationStore({
    read: async () => ({ version: 1, pages: [] }),
    write: async () => { writes += 1 }
  })

  await assert.rejects(
    mutations.mutate((store) => ({
      store: addSavedPageToStore(store, savedPage('https://example.test/next', 'Next'), 200),
      value: undefined
    })),
    /malformed/
  )

  assert.equal(writes, 0)
})

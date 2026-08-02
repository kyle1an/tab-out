import assert from 'node:assert/strict'
import test from 'node:test'

import { Effect } from 'effect'

import { createSerializedEffectQueue } from '../src/extension/serialized-effect-queue.js'

test('serialized Effect queue preserves FIFO order across an asynchronous first task', async () => {
  const queue = createSerializedEffectQueue()
  const order: string[] = []
  const { promise: firstBlocked, resolve: releaseFirst } = Promise.withResolvers<void>()
  const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>()

  const first = queue.run(Effect.tryPromise({
    try: async () => {
      order.push('first:start')
      markFirstStarted()
      await firstBlocked
      order.push('first:end')
      return 1
    },
    catch: (cause) => cause
  }))
  await firstStarted
  const second = queue.run(Effect.sync(() => {
    order.push('second')
    return 2
  }))

  await Promise.resolve()
  assert.deepEqual(order, ['first:start'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})

test('serialized Effect queue preserves an exact failure and continues draining', async () => {
  const queue = createSerializedEffectQueue()
  const failure = new Error('queued task failed')

  await assert.rejects(queue.run(Effect.fail(failure)), (error) => error === failure)
  assert.equal(await queue.run(Effect.succeed('recovered')), 'recovered')
})

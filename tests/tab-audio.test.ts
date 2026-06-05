import assert from 'node:assert/strict'
import test from 'node:test'

import {
  audioStateForTab,
  aggregateAudioState,
  mergeAudioStates,
  nextMutedForAudioState
} from '../src/extension/tab-audio.js'

test('audioStateForTab: muted wins even when still audible', () => {
  assert.equal(audioStateForTab({ audible: true, muted: true }), 'muted')
  assert.equal(audioStateForTab({ audible: false, muted: true }), 'muted')
})

test('audioStateForTab: playing when audible and unmuted', () => {
  assert.equal(audioStateForTab({ audible: true, muted: false }), 'playing')
})

test('audioStateForTab: null when silent, and tolerant of undefined flags', () => {
  assert.equal(audioStateForTab({ audible: false, muted: false }), null)
  assert.equal(audioStateForTab({}), null)
})

test('mergeAudioStates: playing beats muted beats null', () => {
  assert.equal(mergeAudioStates(['muted', 'playing', null]), 'playing')
  assert.equal(mergeAudioStates(['muted', null]), 'muted')
  assert.equal(mergeAudioStates([null, null]), null)
  assert.equal(mergeAudioStates([]), null)
})

test('aggregateAudioState: any unmuted-audible tab makes the set playing', () => {
  assert.equal(
    aggregateAudioState([{ audible: true, muted: true }, { audible: true, muted: false }]),
    'playing'
  )
})

test('aggregateAudioState: muted when some muted and none unmuted-audible', () => {
  assert.equal(
    aggregateAudioState([{ audible: true, muted: true }, { audible: false, muted: false }]),
    'muted'
  )
})

test('aggregateAudioState: null when the set is silent', () => {
  assert.equal(aggregateAudioState([{ audible: false, muted: false }]), null)
  assert.equal(aggregateAudioState([]), null)
})

test('nextMutedForAudioState: playing → mute (true), muted → unmute (false)', () => {
  assert.equal(nextMutedForAudioState('playing'), true)
  assert.equal(nextMutedForAudioState('muted'), false)
  assert.equal(nextMutedForAudioState(null), false)
})

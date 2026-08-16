import { Schema } from 'effect'

import { omitUndefined } from '../../src/lib/omit-undefined.js'
import type {
  WorkingSetActivityEvent,
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
} from '../../src/extension/types'
import { WORKING_SET_ACTIVITY_VERSION } from '../../src/extension/working-set.js'

const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LIVE_RECORD_STEP_MS = 1000
const EVENT_STEP_MS = 10
const FIXTURE_URL_LENGTH = 256
const FIXTURE_TITLE_LENGTH = 80

export const workingSetStorageProfileNameSchema = Schema.Literals([
  'empty',
  '500x20',
  '500x80',
  '250-live-250-expired',
  '2000x80',
])

export type WorkingSetStorageProfileName =
  typeof workingSetStorageProfileNameSchema.Type

export interface WorkingSetStorageProfile {
  readonly name: WorkingSetStorageProfileName
  readonly now: number
  readonly liveRecordCount: number
  readonly expiredRecordCount: number
  readonly eventsPerRecord: number
  readonly activity: WorkingSetActivityStore
}

type ProfileShape = {
  readonly liveRecordCount: number
  readonly expiredRecordCount: number
  readonly eventsPerRecord: number
}

function indexedLabel(index: number): string {
  return String(index).padStart(4, '0')
}

function exactLengthValue(prefix: string, length: number, fill: string): string {
  if (prefix.length > length) {
    throw new Error(`Working Set fixture prefix exceeds ${String(length)} characters`)
  }
  return `${prefix}${fill.repeat(length - prefix.length)}`
}

function latestEventAt(
  events: readonly WorkingSetActivityEvent[],
  kind: WorkingSetActivityEvent['kind'],
): number | undefined {
  return events.findLast((event) => event.kind === kind)?.at
}

function makeRecord(
  index: number,
  eventCount: number,
  latestAt: number,
): WorkingSetActivityRecord {
  const label = indexedLabel(index)
  const domain = `working-set-${label}.example.test`
  const url = exactLengthValue(
    `https://${domain}/page/${label}?fixture=`,
    FIXTURE_URL_LENGTH,
    'x',
  )
  const title = exactLengthValue(
    `Working Set ${label} `,
    FIXTURE_TITLE_LENGTH,
    't',
  )
  const events = Array.from({ length: eventCount }, (_, eventIndex) => ({
    kind: eventIndex % 2 === 0 ? 'activation' : 'navigation',
    at: latestAt - ((eventCount - eventIndex - 1) * EVENT_STEP_MS),
  })) satisfies WorkingSetActivityEvent[]
  const lastActivatedAt = latestEventAt(events, 'activation')
  const lastNavigatedAt = latestEventAt(events, 'navigation')

  return {
    key: url,
    url,
    title,
    domain,
    lastSeenAt: latestAt,
    ...omitUndefined({ lastActivatedAt, lastNavigatedAt }),
    events,
  }
}

function makeActivity(now: number, shape: ProfileShape): WorkingSetActivityStore {
  const records: Record<string, WorkingSetActivityRecord> = {}
  for (let index = 0; index < shape.liveRecordCount; index += 1) {
    const record = makeRecord(
      index,
      shape.eventsPerRecord,
      now - (index * LIVE_RECORD_STEP_MS),
    )
    records[record.key] = record
  }
  for (let index = 0; index < shape.expiredRecordCount; index += 1) {
    const recordIndex = shape.liveRecordCount + index
    const record = makeRecord(
      recordIndex,
      shape.eventsPerRecord,
      now - ACTIVITY_RETENTION_MS - EVENT_STEP_MS -
      (index * LIVE_RECORD_STEP_MS),
    )
    records[record.key] = record
  }
  return {
    version: WORKING_SET_ACTIVITY_VERSION,
    records,
  }
}

function profileShape(name: WorkingSetStorageProfileName): ProfileShape {
  switch (name) {
    case 'empty':
      return { liveRecordCount: 0, expiredRecordCount: 0, eventsPerRecord: 0 }
    case '500x20':
      return { liveRecordCount: 500, expiredRecordCount: 0, eventsPerRecord: 20 }
    case '500x80':
      return { liveRecordCount: 500, expiredRecordCount: 0, eventsPerRecord: 80 }
    case '250-live-250-expired':
      return { liveRecordCount: 250, expiredRecordCount: 250, eventsPerRecord: 20 }
    case '2000x80':
      return { liveRecordCount: 2000, expiredRecordCount: 0, eventsPerRecord: 80 }
  }
}

export function makeWorkingSetStorageProfile(
  name: WorkingSetStorageProfileName,
  now: number,
): WorkingSetStorageProfile {
  if (!Number.isFinite(now)) {
    throw new Error('Working Set storage fixture time must be finite')
  }
  const shape = profileShape(name)
  return {
    name,
    now,
    ...shape,
    activity: makeActivity(now, shape),
  }
}

export function makeWorkingSetStorageProfiles(
  now: number,
): readonly WorkingSetStorageProfile[] {
  return [
    makeWorkingSetStorageProfile('empty', now),
    makeWorkingSetStorageProfile('500x20', now),
    makeWorkingSetStorageProfile('500x80', now),
    makeWorkingSetStorageProfile('250-live-250-expired', now),
    makeWorkingSetStorageProfile('2000x80', now),
  ]
}

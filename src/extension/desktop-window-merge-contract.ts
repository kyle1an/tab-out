import { Schema } from 'effect'

export const DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE =
  'tab-out:get-desktop-window-merge-status'
export const DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE =
  'tab-out:preview-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE =
  'tab-out:confirm-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE =
  'tab-out:acknowledge-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE =
  'tab-out:desktop-window-merge-status-changed'

export const DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY =
  'desktopWindowMergeSessionV1'

const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0))
const nonNegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const opaqueIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)

const desktopWindowMergeAvailabilityReasonSchema = Schema.Literals([
  'controller-update-required',
  'coordination-unavailable',
  'native-integration-required',
  'session-storage-unavailable',
])

export const desktopWindowMergeRequestFailureReasonSchema = Schema.Literals([
  'browser-read-failed',
  'controller-update-required',
  'coordination-unavailable',
  'desktop-selection-unavailable',
  'native-integration-required',
  'session-storage-unavailable',
])

export type DesktopWindowMergeRequestFailureReason =
  typeof desktopWindowMergeRequestFailureReasonSchema.Type

const desktopWindowMergeErrorCodeSchema = Schema.Literals([
  'browser-mutation-failed',
  'interrupted',
  'session-storage-unavailable',
])

const desktopWindowMergeJournalSchema = Schema.Struct({
  version: Schema.Literals([1]),
  sessionId: opaqueIdSchema,
  status: Schema.Literals(['running', 'succeeded', 'partial', 'interrupted']),
  ownerTabId: positiveIntegerSchema,
  destinationWindowId: positiveIntegerSchema,
  sourceWindowCount: positiveIntegerSchema,
  plannedTabCount: positiveIntegerSchema,
  movedTabCount: nonNegativeIntegerSchema,
  remainingTabCount: nonNegativeIntegerSchema,
  startedAtMs: Schema.Finite,
  updatedAtMs: Schema.Finite,
  errorCode: Schema.optionalKey(desktopWindowMergeErrorCodeSchema),
}).check(Schema.makeFilter((journal) => {
  if (journal.movedTabCount + journal.remainingTabCount !== journal.plannedTabCount) {
    return 'Moved and remaining tab counts must equal the planned tab count'
  }
  if (journal.updatedAtMs < journal.startedAtMs) {
    return 'The window merge update time cannot precede its start time'
  }
  if (journal.status === 'running') {
    return journal.errorCode === undefined
      ? undefined
      : 'A running window merge cannot have an error code'
  }
  if (journal.status === 'succeeded') {
    return journal.remainingTabCount === 0 && journal.errorCode === undefined
      ? undefined
      : 'A successful window merge must have no remaining tabs or error code'
  }
  if (journal.status === 'interrupted') {
    return journal.errorCode === 'interrupted'
      ? undefined
      : 'An interrupted window merge must use the interrupted error code'
  }
  return journal.errorCode === undefined
    ? 'A partial window merge must have an error code'
    : undefined
}))

export type DesktopWindowMergeJournal =
  typeof desktopWindowMergeJournalSchema.Type

const desktopWindowMergeAvailabilitySchema = Schema.Union([
  Schema.Struct({ available: Schema.Literals([true]) }),
  Schema.Struct({
    available: Schema.Literals([false]),
    reason: desktopWindowMergeAvailabilityReasonSchema,
  }),
])

export type DesktopWindowMergeAvailability =
  typeof desktopWindowMergeAvailabilitySchema.Type

const desktopWindowMergeStatusResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  availability: desktopWindowMergeAvailabilitySchema,
  session: Schema.NullOr(Schema.Struct({
    journal: desktopWindowMergeJournalSchema,
    isOwner: Schema.Boolean,
  })),
})

const desktopWindowMergePreviewResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['ready']),
    previewId: opaqueIdSchema,
    sourceWindowCount: positiveIntegerSchema,
    movingTabCount: positiveIntegerSchema,
  }),
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['already-merged', 'busy']),
  }),
  Schema.Struct({
    ok: Schema.Literals([false]),
    reason: desktopWindowMergeRequestFailureReasonSchema,
  }),
])

const desktopWindowMergeConfirmResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['succeeded', 'partial']),
    journal: desktopWindowMergeJournalSchema,
  }),
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['changed']),
    previewId: opaqueIdSchema,
    sourceWindowCount: positiveIntegerSchema,
    movingTabCount: positiveIntegerSchema,
  }),
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['already-merged', 'busy']),
  }),
  Schema.Struct({
    ok: Schema.Literals([false]),
    reason: desktopWindowMergeRequestFailureReasonSchema,
  }),
])

const desktopWindowMergeAcknowledgeResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
})

const desktopWindowMergeStatusGetMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE]),
})
const desktopWindowMergePreviewMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE]),
})
const desktopWindowMergeConfirmMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE]),
  previewId: opaqueIdSchema,
})
const desktopWindowMergeAcknowledgeMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE]),
  sessionId: opaqueIdSchema,
})
const desktopWindowMergeStatusChangedMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE]),
})

export type DesktopWindowMergeStatusResponse =
  typeof desktopWindowMergeStatusResponseSchema.Type
export type DesktopWindowMergePreviewResponse =
  typeof desktopWindowMergePreviewResponseSchema.Type
export type DesktopWindowMergeConfirmResponse =
  typeof desktopWindowMergeConfirmResponseSchema.Type

const isStatusGetMessage = Schema.is(desktopWindowMergeStatusGetMessageSchema)
const isPreviewMessage = Schema.is(desktopWindowMergePreviewMessageSchema)
const isConfirmMessage = Schema.is(desktopWindowMergeConfirmMessageSchema)
const isAcknowledgeMessage = Schema.is(desktopWindowMergeAcknowledgeMessageSchema)
const isStatusChangedMessage = Schema.is(desktopWindowMergeStatusChangedMessageSchema)
const isStatusResponse = Schema.is(desktopWindowMergeStatusResponseSchema)
const isPreviewResponse = Schema.is(desktopWindowMergePreviewResponseSchema)
const isConfirmResponse = Schema.is(desktopWindowMergeConfirmResponseSchema)
const isAcknowledgeResponse = Schema.is(desktopWindowMergeAcknowledgeResponseSchema)
const isJournal = Schema.is(desktopWindowMergeJournalSchema)

export function isDesktopWindowMergeStatusGetMessage(value: unknown): boolean {
  return isStatusGetMessage(value)
}

export function isDesktopWindowMergePreviewMessage(value: unknown): boolean {
  return isPreviewMessage(value)
}

export function parseDesktopWindowMergeConfirmMessage(
  value: unknown,
): typeof desktopWindowMergeConfirmMessageSchema.Type | null {
  return isConfirmMessage(value) ? value : null
}

export function parseDesktopWindowMergeAcknowledgeMessage(
  value: unknown,
): typeof desktopWindowMergeAcknowledgeMessageSchema.Type | null {
  return isAcknowledgeMessage(value) ? value : null
}

export function isDesktopWindowMergeStatusChangedMessage(value: unknown): boolean {
  return isStatusChangedMessage(value)
}

export function parseDesktopWindowMergeStatusResponse(
  value: unknown,
): DesktopWindowMergeStatusResponse | null {
  return isStatusResponse(value) ? value : null
}

export function parseDesktopWindowMergePreviewResponse(
  value: unknown,
): DesktopWindowMergePreviewResponse | null {
  return isPreviewResponse(value) ? value : null
}

export function parseDesktopWindowMergeConfirmResponse(
  value: unknown,
): DesktopWindowMergeConfirmResponse | null {
  return isConfirmResponse(value) ? value : null
}

export function parseDesktopWindowMergeAcknowledgeResponse(
  value: unknown,
): typeof desktopWindowMergeAcknowledgeResponseSchema.Type | null {
  return isAcknowledgeResponse(value) ? value : null
}

export function parseDesktopWindowMergeJournal(
  value: unknown,
): DesktopWindowMergeJournal | null {
  return isJournal(value) ? value : null
}

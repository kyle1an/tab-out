import { Schema } from 'effect'

export const CLOSED_TAB_RESTORE_STATE_MESSAGE = 'tab-out:closed-tab-restore-state'
export const DASHBOARD_SERVICE_STATE_GET_MESSAGE = 'tab-out:get-dashboard-service-state'
export const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
export const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

const closedTabRestoreMessageEnvelopeSchema = Schema.Struct({
  type: Schema.Literals([CLOSED_TAB_RESTORE_STATE_MESSAGE])
})

const closedTabRestoreStateMessageSchema = Schema.Struct({
  type: Schema.Literals([CLOSED_TAB_RESTORE_STATE_MESSAGE]),
  restoreId: Schema.String.check(Schema.isMinLength(1)),
  phase: Schema.Literals(['started', 'settled']),
  restored: Schema.optionalKey(Schema.Boolean)
})

export type ClosedTabRestoreStateMessage = typeof closedTabRestoreStateMessageSchema.Type

const isClosedTabRestoreMessageEnvelope = Schema.is(closedTabRestoreMessageEnvelopeSchema)
const isClosedTabRestoreStateMessage = Schema.is(closedTabRestoreStateMessageSchema)

export function isClosedTabRestoreMessage(value: unknown): boolean {
  return isClosedTabRestoreMessageEnvelope(value)
}

export function parseClosedTabRestoreStateMessage(value: unknown): ClosedTabRestoreStateMessage | null {
  return isClosedTabRestoreStateMessage(value) ? value : null
}

const tabHistoryGetMessageSchema = Schema.Struct({
  type: Schema.Literals([TAB_HISTORY_GET_MESSAGE])
})

const tabHistorySwitchMessageSchema = Schema.Struct({
  type: Schema.Literals([TAB_HISTORY_SWITCH_MESSAGE]),
  direction: Schema.optionalKey(Schema.Unknown)
})

const dashboardServiceStateGetMessageSchema = Schema.Struct({
  type: Schema.Literals([DASHBOARD_SERVICE_STATE_GET_MESSAGE])
})

const isTabHistoryGetMessageSchema = Schema.is(tabHistoryGetMessageSchema)
const isTabHistorySwitchMessageSchema = Schema.is(tabHistorySwitchMessageSchema)
const isDashboardServiceStateGetMessageSchema = Schema.is(dashboardServiceStateGetMessageSchema)
const isTabHistoryDirection = Schema.is(Schema.Literals([-1, 1]))

export function isTabHistoryGetMessage(value: unknown): boolean {
  return isTabHistoryGetMessageSchema(value)
}

export function parseTabHistorySwitchDirection(value: unknown): -1 | 1 | null {
  if (!isTabHistorySwitchMessageSchema(value)) return null
  return isTabHistoryDirection(value.direction) ? value.direction : -1
}

export function isDashboardServiceStateGetMessage(value: unknown): boolean {
  return isDashboardServiceStateGetMessageSchema(value)
}

const tabHistorySuccessResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  snapshot: Schema.Struct({
    entries: Schema.mutable(Schema.Array(Schema.Unknown))
  })
})

const isTabHistorySuccessResponse = Schema.is(tabHistorySuccessResponseSchema)

export function parseTabHistorySuccessResponse(value: unknown): unknown | null {
  return isTabHistorySuccessResponse(value) ? value.snapshot : null
}

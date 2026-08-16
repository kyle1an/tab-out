import { Schema } from 'effect'

import { omitUndefined } from '../lib/omit-undefined.js'
import {
  dashboardRetainedPagesWireSchema,
  type DashboardRetainedPagesWire,
} from './dashboard-retained-pages-wire.js'
import {
  parseRetentionHealthEpisodeValue,
  retentionHealthEpisodeSchema,
  type RetentionHealthEpisode,
} from './retention-health.js'
import type { ChromeOpenTabsSnapshot } from './tabs.js'

const serializedMutedInfoSchema = Schema.Struct({
  muted: Schema.Boolean,
})

const serializedChromeTabSchema = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(['unloaded', 'loading', 'complete'])),
  index: Schema.optionalKey(Schema.Int),
  openerTabId: Schema.optionalKey(Schema.Int),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  pendingUrl: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
  highlighted: Schema.optionalKey(Schema.Boolean),
  windowId: Schema.Int,
  active: Schema.optionalKey(Schema.Boolean),
  favIconUrl: Schema.optionalKey(Schema.String),
  frozen: Schema.optionalKey(Schema.Boolean),
  id: Schema.optionalKey(Schema.Int),
  incognito: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(Schema.Boolean),
  audible: Schema.optionalKey(Schema.Boolean),
  discarded: Schema.optionalKey(Schema.Boolean),
  autoDiscardable: Schema.optionalKey(Schema.Boolean),
  mutedInfo: Schema.optionalKey(serializedMutedInfoSchema),
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  sessionId: Schema.optionalKey(Schema.String),
  splitViewId: Schema.optionalKey(Schema.Int),
  groupId: Schema.optionalKey(Schema.Int),
  lastAccessed: Schema.optionalKey(Schema.Finite),
})

type SerializedChromeTab = typeof serializedChromeTabSchema.Type

function normalizeSerializedChromeTab(tab: SerializedChromeTab): chrome.tabs.Tab {
  return omitUndefined({
    index: tab.index ?? 0,
    pinned: tab.pinned ?? false,
    highlighted: tab.highlighted ?? false,
    windowId: tab.windowId,
    active: tab.active ?? false,
    frozen: tab.frozen ?? false,
    incognito: tab.incognito ?? false,
    selected: tab.selected ?? false,
    discarded: tab.discarded ?? false,
    autoDiscardable: tab.autoDiscardable ?? true,
    groupId: tab.groupId ?? -1,
    lastAccessed: tab.lastAccessed ?? 0,
    status: tab.status,
    openerTabId: tab.openerTabId,
    title: tab.title,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    favIconUrl: tab.favIconUrl,
    id: tab.id,
    audible: tab.audible,
    mutedInfo: tab.mutedInfo,
    width: tab.width,
    height: tab.height,
    sessionId: tab.sessionId,
    splitViewId: tab.splitViewId,
  })
}

const serializedChromeWindowSchema = Schema.Struct({
  top: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  width: Schema.optionalKey(Schema.Finite),
  state: Schema.optionalKey(Schema.Literals(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen'])),
  focused: Schema.optionalKey(Schema.Boolean),
  alwaysOnTop: Schema.optionalKey(Schema.Boolean),
  incognito: Schema.optionalKey(Schema.Boolean),
  type: Schema.optionalKey(Schema.Literals(['normal', 'popup', 'panel', 'app', 'devtools'])),
  id: Schema.optionalKey(Schema.Int),
  left: Schema.optionalKey(Schema.Finite),
  sessionId: Schema.optionalKey(Schema.String),
})

type SerializedChromeWindow = typeof serializedChromeWindowSchema.Type

function normalizeSerializedChromeWindow(window: SerializedChromeWindow): chrome.windows.Window {
  return omitUndefined({
    focused: window.focused ?? false,
    alwaysOnTop: window.alwaysOnTop ?? false,
    incognito: window.incognito ?? false,
    top: window.top,
    height: window.height,
    width: window.width,
    state: window.state,
    type: window.type,
    id: window.id,
    left: window.left,
    sessionId: window.sessionId,
  })
}

const dashboardServiceStateResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  tabHistory: Schema.Struct({
    entries: Schema.mutable(Schema.Array(Schema.Unknown)),
  }),
  workingSetActivity: Schema.Struct({
    version: Schema.Literals([1]),
    records: Schema.Record(Schema.String, Schema.Unknown),
  }),
  openTabsSnapshot: Schema.Struct({
    tabs: Schema.mutable(Schema.Array(serializedChromeTabSchema)),
    windows: Schema.mutable(Schema.Array(serializedChromeWindowSchema)),
  }),
  retainedPages: dashboardRetainedPagesWireSchema,
  retentionHealth: Schema.NullOr(retentionHealthEpisodeSchema),
})

const isDashboardServiceStateResponse = Schema.is(dashboardServiceStateResponseSchema)

export type ParsedDashboardServiceStateResponse = {
  tabHistory: unknown
  workingSetActivity: unknown
  openTabsSnapshot: ChromeOpenTabsSnapshot
  retainedPages: DashboardRetainedPagesWire
  retentionHealth: RetentionHealthEpisode | null
}

export function parseDashboardServiceStateResponse(value: unknown): ParsedDashboardServiceStateResponse | null {
  if (!isDashboardServiceStateResponse(value)) return null
  const retentionHealth = value.retentionHealth === null
    ? null
    : parseRetentionHealthEpisodeValue(value.retentionHealth)
  if (value.retentionHealth !== null && retentionHealth === null) return null
  return {
    tabHistory: value.tabHistory,
    workingSetActivity: value.workingSetActivity,
    retainedPages: value.retainedPages,
    retentionHealth,
    openTabsSnapshot: {
      tabs: value.openTabsSnapshot.tabs.map(normalizeSerializedChromeTab),
      windows: value.openTabsSnapshot.windows.map(normalizeSerializedChromeWindow),
    },
  }
}

import { z } from 'zod/v4-mini'
import type { RequireAtLeastOne, Simplify } from 'type-fest'

import type { CustomGroupRule, PathGroupResult, PathGroupRule, UrlCanonicalizerRule } from './types'

type LocalConfigSource = 'LOCAL_CUSTOM_GROUPS' | 'LOCAL_PATH_GROUPERS' | 'LOCAL_URL_CANONICALIZERS'
type LocalConfigSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ message: string }> } }
}
type LocalConfigHostSelector = RequireAtLeastOne<{
  hostname?: string
  hostnameEndsWith?: string
}, 'hostname' | 'hostnameEndsWith'>
type LocalCustomGroupRuleData = Simplify<
  LocalConfigHostSelector & Pick<CustomGroupRule, 'pathPrefix' | 'groupKey' | 'groupLabel'>
>
type LocalPathGroupRuleData = LocalConfigHostSelector
type LocalUrlCanonicalizerRuleData = LocalConfigHostSelector

export type LocalConfigWarning = {
  source: LocalConfigSource
  index: number | null
  reason: string
}

const nonEmptyStringSchema = z.string().check(z.trim(), z.minLength(1))
const pathGroupCategorySchema = z.enum(['pull', 'issue', 'commit', 'code', 'other'])
const hasHostnameSelector = (rule: { hostname?: string; hostnameEndsWith?: string }): rule is LocalConfigHostSelector =>
  !!(rule.hostname || rule.hostnameEndsWith)

const customGroupRuleSchema = z
  .object({
    hostname: z.optional(nonEmptyStringSchema),
    hostnameEndsWith: z.optional(nonEmptyStringSchema),
    pathPrefix: z.optional(nonEmptyStringSchema),
    groupKey: nonEmptyStringSchema,
    groupLabel: nonEmptyStringSchema
  })
  .check(z.refine(hasHostnameSelector, { message: 'expected hostname or hostnameEndsWith' }))

const pathGroupRuleDataSchema = z
  .object({
    hostname: z.optional(nonEmptyStringSchema),
    hostnameEndsWith: z.optional(nonEmptyStringSchema)
  })
  .check(z.refine(hasHostnameSelector, { message: 'expected hostname or hostnameEndsWith' }))

const urlCanonicalizerRuleDataSchema = z
  .object({
    hostname: z.optional(nonEmptyStringSchema),
    hostnameEndsWith: z.optional(nonEmptyStringSchema)
  })
  .check(z.refine(hasHostnameSelector, { message: 'expected hostname or hostnameEndsWith' }))

const pathGroupResultSchema = z.object({
  key: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  category: z.optional(pathGroupCategorySchema),
  alwaysCluster: z.optional(z.boolean())
})

const unsetLocalConfigCache = Symbol('unsetLocalConfigCache')
const warnedLocalConfigKeys = new Set<string>()
let cachedCustomGroupsInput: unknown = unsetLocalConfigCache
let cachedCustomGroups: CustomGroupRule[] = []
let cachedPathGroupersInput: unknown = unsetLocalConfigCache
let cachedPathGroupers: PathGroupRule[] = []
let cachedUrlCanonicalizersInput: unknown = unsetLocalConfigCache
let cachedUrlCanonicalizers: UrlCanonicalizerRule[] = []

function warningKey(warning: LocalConfigWarning) {
  return `${warning.source}:${warning.index ?? 'source'}:${warning.reason}`
}

function pushWarning(warnings: LocalConfigWarning[] | undefined, warning: LocalConfigWarning) {
  warnings?.push(warning)
}

function warnLocalConfigOnce(warning: LocalConfigWarning) {
  const key = warningKey(warning)
  if (warnedLocalConfigKeys.has(key)) return
  warnedLocalConfigKeys.add(key)
  console.warn('Tab Out ignored an invalid local config rule.', {
    source: warning.source,
    index: warning.index,
    reason: warning.reason
  })
}

function parseItem<T>(
  source: LocalConfigSource,
  index: number,
  value: unknown,
  schema: LocalConfigSchema<T>,
  warnings?: LocalConfigWarning[]
): T | null {
  const result = schema.safeParse(value)
  if (result.success === false) {
    pushWarning(warnings, {
      source,
      index,
      reason: result.error.issues[0]?.message || 'expected valid local config rule'
    })
    return null
  }

  return result.data
}

function normalizeLocalConfigArray(
  source: LocalConfigSource,
  input: unknown,
  warnings?: LocalConfigWarning[]
): unknown[] {
  if (input == null) return []
  if (Array.isArray(input)) return input

  pushWarning(warnings, {
    source,
    index: null,
    reason: 'expected an array'
  })
  return []
}

function normalizePathGroupResult(source: LocalConfigSource, index: number, value: unknown): PathGroupResult | null {
  if (value == null) return null

  const result = pathGroupResultSchema.safeParse(value)
  if (result.success) return result.data

  warnLocalConfigOnce({
    source,
    index,
    reason: result.error.issues[0]?.message || 'expected valid path group result'
  })
  return null
}

function normalizeUrlCanonicalKey(source: LocalConfigSource, index: number, value: unknown): string | null {
  if (value == null) return null

  const result = nonEmptyStringSchema.safeParse(value)
  if (result.success) return result.data

  warnLocalConfigOnce({
    source,
    index,
    reason: result.error.issues[0]?.message || 'expected a non-empty canonical key'
  })
  return null
}

function isLocalCustomGroupRuleData(rule: z.infer<typeof customGroupRuleSchema>): rule is LocalCustomGroupRuleData {
  return hasHostnameSelector(rule)
}

function pathGroupRuleFromLocalRule(rule: LocalPathGroupRuleData, index: number, value: unknown): PathGroupRule | null {
  if (value === null || typeof value !== 'object') return null

  const extract = (value as { extract?: unknown }).extract
  if (typeof extract !== 'function') return null

  return {
    ...('hostname' in rule && rule.hostname ? { hostname: rule.hostname } : {}),
    ...('hostnameEndsWith' in rule && rule.hostnameEndsWith ? { hostnameEndsWith: rule.hostnameEndsWith } : {}),
    extract: (url: URL) => {
      try {
        return normalizePathGroupResult(
          'LOCAL_PATH_GROUPERS',
          index,
          (extract as (url: URL) => unknown)(url)
        )
      } catch {
        warnLocalConfigOnce({
          source: 'LOCAL_PATH_GROUPERS',
          index,
          reason: 'extract threw'
        })
        return null
      }
    }
  }
}

function urlCanonicalizerRuleFromLocalRule(rule: LocalUrlCanonicalizerRuleData, index: number, value: unknown): UrlCanonicalizerRule | null {
  if (value === null || typeof value !== 'object') return null

  const canonicalize = (value as { canonicalize?: unknown }).canonicalize
  if (typeof canonicalize !== 'function') return null

  return {
    ...('hostname' in rule && rule.hostname ? { hostname: rule.hostname } : {}),
    ...('hostnameEndsWith' in rule && rule.hostnameEndsWith ? { hostnameEndsWith: rule.hostnameEndsWith } : {}),
    canonicalize: (url: URL) => {
      try {
        return normalizeUrlCanonicalKey(
          'LOCAL_URL_CANONICALIZERS',
          index,
          (canonicalize as (url: URL) => unknown)(url)
        )
      } catch {
        warnLocalConfigOnce({
          source: 'LOCAL_URL_CANONICALIZERS',
          index,
          reason: 'canonicalize threw'
        })
        return null
      }
    }
  }
}

export function normalizeLocalCustomGroups(input: unknown, warnings?: LocalConfigWarning[]): CustomGroupRule[] {
  return normalizeLocalConfigArray('LOCAL_CUSTOM_GROUPS', input, warnings)
    .map((value, index) => parseItem('LOCAL_CUSTOM_GROUPS', index, value, customGroupRuleSchema, warnings))
    .filter((rule): rule is LocalCustomGroupRuleData => rule !== null && isLocalCustomGroupRuleData(rule))
}

export function normalizeLocalPathGroupers(input: unknown, warnings?: LocalConfigWarning[]): PathGroupRule[] {
  return normalizeLocalConfigArray('LOCAL_PATH_GROUPERS', input, warnings)
    .map((value, index) => {
      if (value === null || typeof value !== 'object') {
        pushWarning(warnings, {
          source: 'LOCAL_PATH_GROUPERS',
          index,
          reason: 'expected an object'
        })
        return null
      }

      if (typeof (value as { extract?: unknown }).extract !== 'function') {
        pushWarning(warnings, {
          source: 'LOCAL_PATH_GROUPERS',
          index,
          reason: 'expected extract function'
        })
        return null
      }

      const rule = parseItem('LOCAL_PATH_GROUPERS', index, value, pathGroupRuleDataSchema, warnings)
      return rule && hasHostnameSelector(rule) ? pathGroupRuleFromLocalRule(rule, index, value) : null
    })
    .filter((rule): rule is PathGroupRule => rule !== null)
}

export function normalizeLocalUrlCanonicalizers(input: unknown, warnings?: LocalConfigWarning[]): UrlCanonicalizerRule[] {
  return normalizeLocalConfigArray('LOCAL_URL_CANONICALIZERS', input, warnings)
    .map((value, index) => {
      if (value === null || typeof value !== 'object') {
        pushWarning(warnings, {
          source: 'LOCAL_URL_CANONICALIZERS',
          index,
          reason: 'expected an object'
        })
        return null
      }

      if (typeof (value as { canonicalize?: unknown }).canonicalize !== 'function') {
        pushWarning(warnings, {
          source: 'LOCAL_URL_CANONICALIZERS',
          index,
          reason: 'expected canonicalize function'
        })
        return null
      }

      const rule = parseItem('LOCAL_URL_CANONICALIZERS', index, value, urlCanonicalizerRuleDataSchema, warnings)
      return rule && hasHostnameSelector(rule) ? urlCanonicalizerRuleFromLocalRule(rule, index, value) : null
    })
    .filter((rule): rule is UrlCanonicalizerRule => rule !== null)
}

function warnLocalConfigWarnings(warnings: LocalConfigWarning[]) {
  warnings.forEach(warnLocalConfigOnce)
}

export function readLocalCustomGroups(): CustomGroupRule[] {
  const input = typeof window === 'undefined' ? undefined : (window.LOCAL_CUSTOM_GROUPS as unknown)
  if (input === cachedCustomGroupsInput) return cachedCustomGroups

  const warnings: LocalConfigWarning[] = []
  const groups = normalizeLocalCustomGroups(input, warnings)
  warnLocalConfigWarnings(warnings)
  cachedCustomGroupsInput = input
  cachedCustomGroups = groups
  return groups
}

export function readLocalPathGroupers(): PathGroupRule[] {
  const input = typeof window === 'undefined' ? undefined : (window.LOCAL_PATH_GROUPERS as unknown)
  if (input === cachedPathGroupersInput) return cachedPathGroupers

  const warnings: LocalConfigWarning[] = []
  const groupers = normalizeLocalPathGroupers(input, warnings)
  warnLocalConfigWarnings(warnings)
  cachedPathGroupersInput = input
  cachedPathGroupers = groupers
  return groupers
}

export function readLocalUrlCanonicalizers(): UrlCanonicalizerRule[] {
  const input = typeof window === 'undefined' ? undefined : (window.LOCAL_URL_CANONICALIZERS as unknown)
  if (input === cachedUrlCanonicalizersInput) return cachedUrlCanonicalizers

  const warnings: LocalConfigWarning[] = []
  const canonicalizers = normalizeLocalUrlCanonicalizers(input, warnings)
  warnLocalConfigWarnings(warnings)
  cachedUrlCanonicalizersInput = input
  cachedUrlCanonicalizers = canonicalizers
  return canonicalizers
}

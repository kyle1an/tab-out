import type { DashboardChipData, DashboardTitleVariantPresentation } from './types'

const MAX_URL_VARIANT_LABEL_LENGTH = 64
const OPAQUE_QUERY_VALUE_MIN_LENGTH = 24
const SEMANTIC_VALUE_WORD = /^[A-Za-z]{2,16}$/

type PathToken = {
  kind: 'path'
  value: string
}

type QueryToken = {
  kind: 'query'
  key: string
  value: string
}

type HashToken = {
  kind: 'hash'
  value: string
}

type UrlVariantToken = PathToken | QueryToken | HashToken

type ParsedUrlVariant = {
  exactUrl: string
  host: string
  hostLabel: string
  originKey: string
  pathname: string
  pathLabel: string
  tokens: UrlVariantToken[]
}

type IndexedParsedUrlVariant = ParsedUrlVariant & {
  targetIndex: number
}

type UrlVariantLabelCandidate = Pick<ParsedUrlVariant, 'exactUrl' | 'hostLabel' | 'pathLabel'> & {
  label: string
}

export type UrlVariantPresentation = {
  exactUrl: string
  label: string
}

export type UrlVariantPresentationGroup = {
  label: string
  targetIndexes: number[]
}

export function titleVariantTargets(
  presentations: readonly DashboardTitleVariantPresentation[] | null | undefined,
): DashboardChipData[] {
  return presentations?.flatMap(({ targets }) => targets) ?? []
}

type UrlVariantPresentationGroupOptions = {
  collapseOpaqueValues?: boolean
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0')
}

function boundedLabel(label: string, exactUrl: string): string {
  if (label.length <= MAX_URL_VARIANT_LABEL_LENGTH) return label
  const fingerprint = `…${stableFingerprint(exactUrl)}`
  return `${label.slice(0, MAX_URL_VARIANT_LABEL_LENGTH - fingerprint.length)}${fingerprint}`
}

function wordLikeSemanticValue(value: string): boolean {
  const words = value.split(/[-_.~:/]+/).filter(Boolean)
  return words.length >= 3 && words.every((word) => SEMANTIC_VALUE_WORD.test(word))
}

function opaqueQueryValue(value: string): boolean {
  return value.length >= OPAQUE_QUERY_VALUE_MIN_LENGTH
    && /^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/.test(value)
    && !wordLikeSemanticValue(value)
}

function queryValueLabel(value: string): string {
  if (opaqueQueryValue(value)) return `…${stableFingerprint(value)}`
  const encoded = encodeURIComponent(value)
  if (encoded.length <= 32) return encoded
  return `${encoded.slice(0, 24)}…${stableFingerprint(value)}`
}

function hashValueLabel(value: string): string {
  if (opaqueQueryValue(value)) return `…${stableFingerprint(value)}`
  if (value.length <= 32) return value
  return `${value.slice(0, 24)}…${stableFingerprint(value)}`
}

function tokenKey(token: UrlVariantToken): string {
  switch (token.kind) {
    case 'path':
      return `path\u0000${token.value}`
    case 'query':
      return `query\u0000${token.key}\u0000${token.value}`
    case 'hash':
      return `hash\u0000${token.value}`
  }
}

function parsedUrlVariant(exactUrl: string): ParsedUrlVariant | null {
  const parsed = URL.parse(exactUrl)
  if (!parsed) return null
  const pathTokens: PathToken[] = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((value) => ({ kind: 'path', value }))
  const queryTokens: QueryToken[] = Array.from(
    parsed.searchParams.entries(),
    ([key, value]) => ({ kind: 'query', key, value }),
  )
  const hashTokens: HashToken[] = parsed.hash
    ? [{ kind: 'hash', value: parsed.hash.slice(1) }]
    : []
  const suffixTokens: UrlVariantToken[] = [...queryTokens, ...hashTokens]
  const pathLabel = `${parsed.pathname || '/'}${suffixTokens.length > 0 ? renderDifferingTokens(suffixTokens, 0) : ''}`
  const hostLabel = `${parsed.host}${pathLabel}` || exactUrl
  return {
    exactUrl,
    host: parsed.host,
    hostLabel,
    originKey: `${parsed.protocol}//${parsed.host}`,
    pathname: parsed.pathname || '/',
    pathLabel,
    tokens: [...pathTokens, ...queryTokens, ...hashTokens],
  }
}

function commonTokenCounts(variants: readonly ParsedUrlVariant[]): { lead: number, trail: number } {
  const first = variants[0]
  if (!first) return { lead: 0, trail: 0 }
  const minimumLength = Math.min(...variants.map((variant) => variant.tokens.length))
  let lead = 0
  for (let index = 0; index < minimumLength; index++) {
    const key = tokenKey(first.tokens[index] ?? { kind: 'path', value: '' })
    if (variants.every((variant) => tokenKey(variant.tokens[index] ?? { kind: 'path', value: '' }) === key)) {
      lead = index + 1
    } else {
      break
    }
  }

  let trail = 0
  const maximumTrail = minimumLength - lead
  for (let offset = 1; offset <= maximumTrail; offset++) {
    const key = tokenKey(first.tokens.at(-offset) ?? { kind: 'path', value: '' })
    if (variants.every((variant) => tokenKey(variant.tokens.at(-offset) ?? { kind: 'path', value: '' }) === key)) {
      trail = offset
    } else {
      break
    }
  }
  return { lead, trail }
}

function renderDifferingTokens(
  tokens: readonly UrlVariantToken[],
  commonLead: number,
  collapseOpaqueValues = false,
): string {
  if (tokens.length === 0) return '/'
  let label = commonLead > 0 ? '…' : ''
  let queryStarted = false
  for (const token of tokens) {
    switch (token.kind) {
      case 'path':
        label += `/${token.value}`
        break
      case 'query':
        label += queryStarted ? '&' : '?'
        label += `${encodeURIComponent(token.key)}=${collapseOpaqueValues && opaqueQueryValue(token.value) ? '…' : queryValueLabel(token.value)}`
        queryStarted = true
        break
      case 'hash':
        label += `#${collapseOpaqueValues && opaqueQueryValue(token.value) ? '…' : hashValueLabel(token.value)}`
        break
    }
  }
  return label
}

function familyTokenKey(token: UrlVariantToken): string {
  switch (token.kind) {
    case 'path':
      return tokenKey(token)
    case 'query':
      return `query\u0000${token.key}\u0000${opaqueQueryValue(token.value) ? '<opaque>' : token.value}`
    case 'hash':
      return `hash\u0000${opaqueQueryValue(token.value) ? '<opaque>' : token.value}`
  }
}

function hasOpaqueValue(variant: ParsedUrlVariant): boolean {
  return variant.tokens.some((token) => (
    (token.kind === 'query' || token.kind === 'hash') && opaqueQueryValue(token.value)
  ))
}

function familyKey(variant: ParsedUrlVariant, collapseOpaqueValues: boolean): string {
  if (!collapseOpaqueValues || !hasOpaqueValue(variant)) return `exact\u0000${variant.exactUrl}`
  return [variant.originKey, ...variant.tokens.map(familyTokenKey)].join('\u0001')
}

function familyPathLabel(variant: ParsedUrlVariant): string {
  const suffixTokens = variant.tokens.filter((token) => token.kind !== 'path')
  return `${variant.pathname}${suffixTokens.length > 0 ? renderDifferingTokens(suffixTokens, 0, true) : ''}`
}

function collidingLabels(candidates: readonly UrlVariantLabelCandidate[]): Set<string> {
  const urlsByLabel = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    urlsByLabel.getOrInsertComputed(candidate.label, () => new Set<string>()).add(candidate.exactUrl)
  }
  return new Set(
    urlsByLabel.entries()
      .filter(([, urls]) => urls.size > 1)
      .map(([label]) => label),
  )
}

function replaceCollisions(
  candidates: readonly UrlVariantLabelCandidate[],
  replacement: (candidate: UrlVariantLabelCandidate) => string,
): UrlVariantLabelCandidate[] {
  const collisions = collidingLabels(candidates)
  if (collisions.size === 0) return [...candidates]
  return candidates.map((candidate) => collisions.has(candidate.label)
    ? { ...candidate, label: boundedLabel(replacement(candidate), candidate.exactUrl) }
    : candidate)
}

function makeLabelsUnique(candidates: readonly UrlVariantLabelCandidate[]): UrlVariantLabelCandidate[] {
  const pathLabels = replaceCollisions(candidates, (candidate) => candidate.pathLabel)
  const hostLabels = replaceCollisions(pathLabels, (candidate) => candidate.hostLabel)
  const fingerprintedLabels = replaceCollisions(
    hostLabels,
    (candidate) => `${candidate.label} · ${stableFingerprint(candidate.exactUrl)}`,
  )
  return replaceCollisions(fingerprintedLabels, (candidate) => candidate.exactUrl)
}

/**
 * Builds bounded, human-readable labels for exact URLs that share one visible
 * title. The returned URL is deliberately untouched: callers use `label` only
 * for presentation and retain `exactUrl` for identity and actions.
 */
export function buildUrlVariantPresentations(exactUrls: readonly string[]): UrlVariantPresentation[] {
  const variants = exactUrls.map(parsedUrlVariant)
  if (variants.some((variant) => variant === null)) {
    const candidates = exactUrls.map((exactUrl) => ({
      exactUrl,
      hostLabel: exactUrl,
      pathLabel: exactUrl,
      label: boundedLabel(exactUrl || '/', exactUrl),
    }))
    return makeLabelsUnique(candidates).map(({ exactUrl, label }) => ({ exactUrl, label }))
  }

  const parsedVariants = variants.filter((variant) => variant !== null)
  if (parsedVariants.length <= 1) {
    return parsedVariants.map((variant) => ({
      exactUrl: variant.exactUrl,
      label: boundedLabel(variant.pathLabel, variant.exactUrl),
    }))
  }

  const { lead, trail } = commonTokenCounts(parsedVariants)
  const candidates = parsedVariants.map((variant) => {
    const differingTokens = variant.tokens.slice(lead, variant.tokens.length - trail)
    return {
      ...variant,
      label: boundedLabel(renderDifferingTokens(differingTokens, lead), variant.exactUrl),
    }
  })
  return makeLabelsUnique(candidates).map(({ exactUrl, label }) => ({ exactUrl, label }))
}

/**
 * Builds the visible rows for a same-title URL group. Target indexes point
 * back to the exact input occurrences, so repeated URLs remain independently
 * actionable while History-only opaque value families may share one row.
 */
export function buildUrlVariantPresentationGroups(
  exactUrls: readonly string[],
  { collapseOpaqueValues = false }: UrlVariantPresentationGroupOptions = {},
): UrlVariantPresentationGroup[] {
  if (!collapseOpaqueValues) {
    return buildUrlVariantPresentations(exactUrls)
      .map(({ label }, targetIndex) => ({ label, targetIndexes: [targetIndex] }))
  }

  const variants = exactUrls.map((exactUrl, targetIndex): IndexedParsedUrlVariant | null => {
    const variant = parsedUrlVariant(exactUrl)
    return variant ? { ...variant, targetIndex } : null
  })
  if (variants.some((variant) => variant === null)) {
    return buildUrlVariantPresentations(exactUrls)
      .map(({ label }, targetIndex) => ({ label, targetIndexes: [targetIndex] }))
  }

  const parsedVariants = variants.filter((variant) => variant !== null)
  const { lead, trail } = commonTokenCounts(parsedVariants)
  const variantsByFamily = Map.groupBy(
    parsedVariants,
    (variant) => familyKey(variant, collapseOpaqueValues),
  )
  const familyEntries = variantsByFamily.entries().toArray()
  const candidates = familyEntries.map(([key, familyVariants]) => {
    const representative = familyVariants[0]
    if (!representative) return null
    const differingTokens = representative.tokens.slice(lead, representative.tokens.length - trail)
    const pathLabel = familyPathLabel(representative)
    return {
      exactUrl: key,
      hostLabel: `${representative.host}${pathLabel}`,
      pathLabel,
      tokens: representative.tokens,
      label: boundedLabel(
        renderDifferingTokens(differingTokens, lead, true),
        key,
      ),
    }
  }).filter((candidate) => candidate !== null)
  const uniqueCandidates = makeLabelsUnique(candidates)
  const labelByFamily = new Map(uniqueCandidates.map(({ exactUrl, label }) => [exactUrl, label]))

  return familyEntries.map(([key, familyVariants]) => ({
    label: labelByFamily.get(key) || '/',
    targetIndexes: familyVariants.map((variant) => variant.targetIndex),
  }))
}

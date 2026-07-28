import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const POLICY_FILE = resolve(import.meta.dirname, '../.github/commit-reference-policy.json')
const ZERO_OBJECT_ID = /^(?:0{40}|0{64})$/
const SAFE_REMOTE_NAME = /^[A-Za-z0-9._-]+$/
const BACKUP_REF = /^refs\/(?:heads|tags)\/backup(?:[\/_-]|$)/

export type CommitReferenceKind =
  | 'bare-reference'
  | 'custom-autolink'
  | 'gh-reference'
  | 'github-url'
  | 'mention'
  | 'qualified-reference'

export interface CommitReferenceFinding {
  column: number
  index: number
  kind: CommitReferenceKind
  line: number
  token: string
}

export interface CustomAutolink {
  isAlphanumeric: boolean
  keyPrefix: string
}

export interface CommitReferencePolicy {
  customAutolinks: readonly CustomAutolink[]
  customAutolinksAudited: boolean
}

export interface PrePushUpdate {
  localObjectId: string
  localRef: string
  remoteObjectId: string
  remoteRef: string
}

export type GitRunner = (args: readonly string[]) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lineAndColumn(message: string, index: number): Pick<CommitReferenceFinding, 'line' | 'column'> {
  const before = message.slice(0, index)
  const lastLineBreak = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: index - lastLineBreak
  }
}

function referenceKind(token: string): CommitReferenceKind {
  if (/^https?:\/\//i.test(token)) return 'github-url'
  if (/^GH-/i.test(token)) return 'gh-reference'
  if (token.includes('/')) return 'qualified-reference'
  return 'bare-reference'
}

function appendMatches(
  findings: CommitReferenceFinding[],
  message: string,
  pattern: RegExp,
  kindForToken: CommitReferenceKind | ((token: string) => CommitReferenceKind)
): void {
  for (const match of message.matchAll(pattern)) {
    if (match.index === undefined) continue
    const token = match[0]
    const kind = typeof kindForToken === 'function' ? kindForToken(token) : kindForToken
    findings.push({
      ...lineAndColumn(message, match.index),
      index: match.index,
      kind,
      token
    })
  }
}

export function parseCommitReferencePolicy(value: unknown): CommitReferencePolicy {
  if (!isRecord(value) || typeof value.customAutolinksAudited !== 'boolean' ||
      !Array.isArray(value.customAutolinks)) {
    throw new Error(
      'commit-reference policy must define customAutolinksAudited and customAutolinks'
    )
  }

  const customAutolinks = value.customAutolinks.map((item, index) => {
    if (!isRecord(item) || typeof item.keyPrefix !== 'string' || item.keyPrefix.length === 0 ||
        typeof item.isAlphanumeric !== 'boolean') {
      throw new Error(`customAutolinks[${index}] must define keyPrefix and isAlphanumeric`)
    }
    return {
      keyPrefix: item.keyPrefix,
      isAlphanumeric: item.isAlphanumeric
    }
  })

  return {
    customAutolinksAudited: value.customAutolinksAudited,
    customAutolinks
  }
}

export function findCommitReferenceFindings(
  message: string,
  policy: CommitReferencePolicy = {
    customAutolinksAudited: false,
    customAutolinks: []
  }
): CommitReferenceFinding[] {
  const findings: CommitReferenceFinding[] = []
  const issueReferences = /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[0-9]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+\b|\bGH-[0-9]+\b|#[0-9]+\b/giu
  const mentions = /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)?/gu

  appendMatches(findings, message, issueReferences, referenceKind)
  appendMatches(findings, message, mentions, 'mention')

  for (const customAutolink of policy.customAutolinks) {
    const identifier = customAutolink.isAlphanumeric ? '[A-Za-z0-9]+' : '[0-9]+'
    const pattern = new RegExp(
      `(?<![A-Za-z0-9])${RegExp.escape(customAutolink.keyPrefix)}${identifier}(?![A-Za-z0-9])`,
      'giu'
    )
    appendMatches(findings, message, pattern, 'custom-autolink')
  }

  const uniqueFindings = new Map<string, CommitReferenceFinding>()
  for (const finding of findings) {
    const key = `${finding.index}:${finding.token.length}`
    const existing = uniqueFindings.get(key)
    if (!existing || existing.kind === 'custom-autolink') uniqueFindings.set(key, finding)
  }
  return [...uniqueFindings.values()].sort((left, right) => left.index - right.index)
}

export function parsePrePushUpdates(input: string): PrePushUpdate[] {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 4) {
        throw new Error(`invalid pre-push input on line ${index + 1}`)
      }
      const [localRef, localObjectId, remoteRef, remoteObjectId] = fields
      if (!localRef || !localObjectId || !remoteRef || !remoteObjectId) {
        throw new Error(`incomplete pre-push input on line ${index + 1}`)
      }
      return { localRef, localObjectId, remoteRef, remoteObjectId }
    })
}

export function outgoingRevisionArguments(
  update: PrePushUpdate,
  remoteName: string
): readonly string[] | null {
  if (ZERO_OBJECT_ID.test(update.localObjectId)) return null
  if (!ZERO_OBJECT_ID.test(update.remoteObjectId)) {
    return [update.localObjectId, `^${update.remoteObjectId}`]
  }
  if (SAFE_REMOTE_NAME.test(remoteName)) {
    return [update.localObjectId, '--not', `--remotes=${remoteName}`]
  }
  return [update.localObjectId]
}

function runGit(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function readPolicy(): CommitReferencePolicy {
  return parseCommitReferencePolicy(JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as unknown)
}

function findingDescription(kind: CommitReferenceKind): string {
  if (kind === 'mention') return 'GitHub mention-shaped text'
  if (kind === 'custom-autolink') return 'configured custom autolink'
  if (kind === 'github-url') return 'direct GitHub issue or pull-request URL'
  return 'GitHub issue or pull-request reference'
}

function reportFindings(
  source: string,
  findings: readonly CommitReferenceFinding[]
): void {
  for (const finding of findings) {
    console.error(
      `${source}:${finding.line}:${finding.column}: ` +
      `${findingDescription(finding.kind)} ${JSON.stringify(finding.token)}`
    )
  }
}

function reportGuidance(): void {
  console.error(
    'Use reference-free prose such as "image 11", "issue 42", or "CSS property at-rule". ' +
    'Put intentional GitHub references and mentions in a reviewed issue or pull-request conversation.'
  )
}

function checkMessage(source: string, message: string, policy: CommitReferencePolicy): boolean {
  const findings = findCommitReferenceFindings(message, policy)
  if (findings.length === 0) return true
  reportFindings(source, findings)
  return false
}

function revisionCommitIds(revisionArguments: readonly string[], git: GitRunner): string[] {
  const output = git(['rev-list', ...revisionArguments])
  return output.split(/\r?\n/).filter(Boolean)
}

function checkCommits(
  commitIds: Iterable<string>,
  policy: CommitReferencePolicy,
  git: GitRunner
): boolean {
  let valid = true
  for (const commitId of new Set(commitIds)) {
    const message = git(['show', '-s', '--format=%B', commitId])
    if (!checkMessage(commitId.slice(0, 12), message, policy)) valid = false
  }
  return valid
}

function checkPrePush(
  input: string,
  remoteName: string,
  policy: CommitReferencePolicy,
  git: GitRunner
): boolean {
  const updates = parsePrePushUpdates(input)
  const blockedRefs = updates
    .filter((update) => !ZERO_OBJECT_ID.test(update.localObjectId))
    .map((update) => update.localRef)
    .filter((ref) => BACKUP_REF.test(ref))
  if (blockedRefs.length > 0) {
    for (const ref of blockedRefs) console.error(`Refusing to push local recovery ref ${ref}`)
    return false
  }

  const commitIds = new Set<string>()
  for (const update of updates) {
    const revisionArguments = outgoingRevisionArguments(update, remoteName)
    if (!revisionArguments) continue
    for (const commitId of revisionCommitIds(revisionArguments, git)) commitIds.add(commitId)
  }
  return checkCommits(commitIds, policy, git)
}

function usage(): void {
  console.error(
    'Usage: check-commit-references.ts ' +
    '<--message-file PATH | --pre-push REMOTE | --range REVISION>'
  )
}

export function commitReferencesMain(
  argv = process.argv.slice(2),
  git: GitRunner = runGit
): number {
  try {
    const args = argv[0] === '--' ? argv.slice(1) : argv
    const policy = readPolicy()
    if (args[0] === '--message-file' && args.length === 2 && args[1]) {
      const valid = checkMessage(args[1], readFileSync(args[1], 'utf8'), policy)
      if (!valid) reportGuidance()
      return valid ? 0 : 1
    }
    if (args[0] === '--range' && args.length === 2 && args[1]) {
      const valid = checkCommits(revisionCommitIds([args[1]], git), policy, git)
      if (!valid) reportGuidance()
      return valid ? 0 : 1
    }
    if (args[0] === '--pre-push' && args.length === 2 && args[1]) {
      const valid = checkPrePush(readFileSync(0, 'utf8'), args[1], policy, git)
      if (!valid) reportGuidance()
      return valid ? 0 : 1
    }
    usage()
    return 2
  } catch (error) {
    console.error(`Commit reference check failed: ${errorMessage(error)}`)
    return 2
  }
}

if (import.meta.main) process.exitCode = commitReferencesMain()

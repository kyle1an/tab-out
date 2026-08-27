import { execFileSync } from 'node:child_process'
import process from 'node:process'

const GENERATED_EXTENSION_PATHS = [
  'extension/index.html',
  'extension/popup.html',
  'extension/manifest.json',
  'extension/dist',
] as const

export type GitStatusRunner = (args: readonly string[]) => string

function runGitStatus(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' })
}

export function unstagedGeneratedEntries(status: string): string[] {
  return status
    .split(/\r?\n/u)
    .filter((line) => line.length >= 3)
    .filter((line) => line.startsWith('??') || line[1] !== ' ')
}

export function generatedExtensionOutputCheckMain(
  runGit: GitStatusRunner = runGitStatus,
): number {
  try {
    const status = runGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...GENERATED_EXTENSION_PATHS,
    ])
    const pendingEntries = unstagedGeneratedEntries(status)
    if (pendingEntries.length === 0) return 0

    console.error(
      'Generated extension output differs from the Git index. ' +
      'Run pnpm build and include every generated file:\n' +
      pendingEntries.map((entry) => `  ${entry}`).join('\n'),
    )
    return 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Could not inspect generated extension output: ${message}`)
    return 2
  }
}

if (import.meta.main) process.exitCode = generatedExtensionOutputCheckMain()

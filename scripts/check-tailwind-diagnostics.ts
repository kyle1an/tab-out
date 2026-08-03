#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  isUnknownRecord,
  parseJsonRpcMessage,
  requireConfigurationParams,
  requirePublishedDiagnosticsParams,
  type Diagnostic,
  type JsonRpcMessage
} from './tailwind-language-server-protocol.ts'

type PendingRequest = {
  resolve(value: unknown): void
  reject(reason?: unknown): void
}

const workspaceRoot = process.cwd()
const workspaceUri = pathToFileURL(`${workspaceRoot}${path.sep}`).href
const serverPackagePath = fileURLToPath(import.meta.resolve('@tailwindcss/language-server/package.json'))
const serverScript = path.join(path.dirname(serverPackagePath), 'bin', 'tailwindcss-language-server')
const supportedExtensions = new Set(['.css', '.html', '.js', '.jsx', '.ts', '.tsx'])
const diagnosticsByUri = new Map<string, readonly Diagnostic[]>()
const publishedUris = new Set<string>()
const pendingRequests = new Map<number, PendingRequest>()
const serverErrors: string[] = []
let nextRequestId = 1
let outputBuffer = Buffer.alloc(0)
let lastDiagnosticsAt = 0

const tailwindSettings = {
  validate: true,
  hovers: false,
  suggestions: false,
  codeActions: true,
  classAttributes: ['class', 'className', 'ngClass', 'toastOptions', 'positionerClassName'],
  classFunctions: ['cn', 'clsx'],
  files: {
    exclude: ['**/.git/**', '**/node_modules/**']
  },
  lint: {
    invalidScreen: 'error',
    invalidVariant: 'error',
    deprecatedAtRule: 'warning',
    invalidTailwindDirective: 'error',
    invalidApply: 'error',
    invalidConfigPath: 'error',
    cssConflict: 'warning',
    recommendedVariantOrder: 'warning',
    usedBlocklistedClass: 'warning',
    suggestCanonicalClasses: 'warning'
  },
  experimental: {
    configFile: 'src/styles/app.css',
    classRegex: [
      ['add\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['cva\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['clsx\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['cn\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['cx\\(([^)]*)\\)', '(?:\'|"|`)([^\']*)(?:\'|"|`)'],
      'twc\\.[^`]+`([^`]*)`',
      'twc\\(.*?\\).*?`([^`]*)`',
      ['twc\\.[^`]+\\(([^)]*)\\)', '(?:\'|"|`)([^\']*)(?:\'|"|`)'],
      ['twc\\(.*?\\).*?\\(([^)]*)\\)', '(?:\'|"|`)([^\']*)(?:\'|"|`)']
    ]
  }
}

function sourceFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'extension/base.css'],
    { cwd: workspaceRoot, encoding: 'utf8' }
  )

  return [...new Set(output.split('\n'))]
    .filter((file) => file.length > 0)
    .filter((file) => supportedExtensions.has(path.extname(file)))
    .sort()
}

function languageIdFor(file: string): string {
  if (file === 'src/styles/app.css') return 'tailwindcss'

  switch (path.extname(file)) {
    case '.css':
      return 'css'
    case '.html':
      return 'html'
    case '.js':
      return 'javascript'
    case '.jsx':
      return 'javascriptreact'
    case '.ts':
      return 'typescript'
    case '.tsx':
      return 'typescriptreact'
    default:
      throw new Error(`Unsupported source file: ${file}`)
  }
}

function send(message: unknown): void {
  const body = JSON.stringify(message)
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++
  send({ jsonrpc: '2.0', id, method, params })

  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  pendingRequests.set(id, { resolve, reject })
  return promise
}

function notify(method: string, params?: unknown): void {
  send({ jsonrpc: '2.0', method, params })
}

function configurationFor(section: string | undefined): unknown {
  if (section === 'tailwindCSS') return tailwindSettings
  if (section?.startsWith('tailwindCSS.')) {
    let value: unknown = tailwindSettings
    for (const key of section.slice('tailwindCSS.'.length).split('.')) {
      if (!isUnknownRecord(value)) return undefined
      value = value[key]
    }
    return value
  }
  if (section === 'editor') return { tabSize: 2 }
  return null
}

function handleServerRequest(message: JsonRpcMessage): void {
  if (message.id === undefined || !message.method) return

  switch (message.method) {
    case 'workspace/configuration': {
      const { items } = requireConfigurationParams(message.params)
      respond(message.id, items.map((item) => configurationFor(item.section)))
      break
    }
    case 'workspace/workspaceFolders':
      respond(message.id, [{ uri: workspaceUri, name: path.basename(workspaceRoot) }])
      break
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      respond(message.id, null)
      break
    case 'workspace/applyEdit':
      respond(message.id, { applied: false })
      break
    case 'window/showMessageRequest':
    case '@/tailwindCSS/getDocumentSymbols':
      respond(message.id, null)
      break
    default:
      respond(message.id, null)
  }
}

function handleMessage(message: JsonRpcMessage): void {
  if (message.method && message.id !== undefined) {
    handleServerRequest(message)
    return
  }

  if (typeof message.id === 'number') {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
    return
  }

  if (message.method === 'textDocument/publishDiagnostics') {
    const { uri, diagnostics } = requirePublishedDiagnosticsParams(message.params)
    diagnosticsByUri.set(uri, diagnostics)
    publishedUris.add(uri)
    lastDiagnosticsAt = Date.now()
  }
}

function parseServerOutput(chunk: Buffer): void {
  outputBuffer = Buffer.concat([outputBuffer, chunk])

  while (true) {
    const headerEnd = outputBuffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return

    const header = outputBuffer.subarray(0, headerEnd).toString('utf8')
    const contentLengthMatch = header.match(/Content-Length: (\d+)/i)
    if (!contentLengthMatch) throw new Error(`Invalid language-server header: ${header}`)

    const contentLength = Number(contentLengthMatch[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (outputBuffer.length < bodyEnd) return

    const body = outputBuffer.subarray(bodyStart, bodyEnd).toString('utf8')
    outputBuffer = outputBuffer.subarray(bodyEnd)
    handleMessage(parseJsonRpcMessage(body))
  }
}

async function waitForDiagnostics(expectedUris: readonly string[]): Promise<void> {
  const timeoutAt = Date.now() + 30_000
  const expectedUriSet = new Set(expectedUris)

  while (Date.now() < timeoutAt) {
    const allPublished = expectedUriSet.isSubsetOf(publishedUris)
    const settled = allPublished && Date.now() - lastDiagnosticsAt >= 500
    if (settled) return
    await delay(100)
  }

  const missingCount = expectedUriSet.difference(publishedUris).size
  throw new Error(
    `Timed out waiting for Tailwind diagnostics (${publishedUris.size}/${expectedUris.length} documents; missing ${missingCount})`
  )
}

function severityName(severity: number | undefined): string {
  if (severity === undefined) return 'unknown'
  return ['unknown', 'error', 'warning', 'information', 'hint'][severity] ?? 'unknown'
}

function relativeFileForUri(uri: string): string {
  return path.relative(workspaceRoot, fileURLToPath(uri))
}

const files = sourceFiles()
const documents = await Promise.all(
  files.map(async (file) => {
    const absolutePath = path.join(workspaceRoot, file)
    return {
      file,
      uri: pathToFileURL(absolutePath).href,
      languageId: languageIdFor(file),
      text: await readFile(absolutePath, 'utf8')
    }
  })
)

const server = spawn(process.execPath, [serverScript, '--stdio'], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
})

server.stdout.on('data', parseServerOutput)
server.stderr.setEncoding('utf8')
server.stderr.on('data', (chunk: string) => serverErrors.push(chunk))

try {
  await request('initialize', {
    processId: process.pid,
    clientInfo: { name: 'tab-out-tailwind-check' },
    rootPath: workspaceRoot,
    rootUri: workspaceUri,
    workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspaceRoot) }],
    capabilities: {
      workspace: {
        configuration: true,
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: false }
      },
      textDocument: {
        publishDiagnostics: {
          relatedInformation: true,
          versionSupport: true
        }
      },
      window: { workDoneProgress: true }
    },
    initializationOptions: {}
  })

  notify('initialized', {})
  notify('workspace/didChangeConfiguration', { settings: { tailwindCSS: tailwindSettings } })

  for (const document of documents) {
    notify('textDocument/didOpen', {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: 1,
        text: document.text
      }
    })
  }

  await waitForDiagnostics(documents.map((document) => document.uri))

  const diagnostics = [...diagnosticsByUri]
    .flatMap(([uri, entries]) => entries.map((diagnostic) => ({ uri, ...diagnostic })))
    .sort((left, right) => {
      const fileOrder = relativeFileForUri(left.uri).localeCompare(relativeFileForUri(right.uri))
      if (fileOrder !== 0) return fileOrder
      if (left.range.start.line !== right.range.start.line) return left.range.start.line - right.range.start.line
      return left.range.start.character - right.range.start.character
    })

  for (const diagnostic of diagnostics) {
    const file = relativeFileForUri(diagnostic.uri)
    const line = diagnostic.range.start.line + 1
    const column = diagnostic.range.start.character + 1
    const code = diagnostic.code ? ` ${diagnostic.code}` : ''
    console.error(`${file}:${line}:${column} ${severityName(diagnostic.severity)}${code}: ${diagnostic.message}`)
  }

  if (diagnostics.length > 0) {
    console.error(`\nTailwind diagnostics: ${diagnostics.length} across ${documents.length} documents.`)
    process.exitCode = 1
  } else {
    console.log(`Tailwind diagnostics: 0 across ${documents.length} documents.`)
  }
} finally {
  try {
    await request('shutdown', null)
    notify('exit')
  } catch {
    server.kill()
  }

  await Promise.race([
    new Promise<void>((resolve) => server.once('exit', () => resolve())),
    delay(2_000)
  ])
  if (server.exitCode === null) server.kill()

  if (serverErrors.length > 0 && process.exitCode) {
    console.error(serverErrors.join('').trim())
  }
}

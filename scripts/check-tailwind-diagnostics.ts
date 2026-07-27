#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

type JsonRpcMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(reason?: unknown): void
}

type Diagnostic = {
  range: {
    start: {
      line: number
      character: number
    }
  }
  severity?: number
  code?: string | number
  message: string
  [key: string]: unknown
}

type PublishedDiagnosticsParams = {
  uri: string
  diagnostics: Diagnostic[]
}

type ConfigurationParams = {
  items: Array<{ section?: string }>
}

const workspaceRoot = process.cwd()
const workspaceUri = pathToFileURL(`${workspaceRoot}${path.sep}`).href
const require = createRequire(import.meta.url)
const serverPackagePath = require.resolve('@tailwindcss/language-server/package.json')
const serverScript = path.join(path.dirname(serverPackagePath), 'bin', 'tailwindcss-language-server')
const supportedExtensions = new Set(['.css', '.html', '.js', '.jsx', '.ts', '.tsx'])
const diagnosticsByUri = new Map<string, Diagnostic[]>()
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

function respond(id: number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++
  send({ jsonrpc: '2.0', id, method, params })

  return new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
  })
}

function notify(method: string, params?: unknown): void {
  send({ jsonrpc: '2.0', method, params })
}

function configurationFor(section: string | undefined): unknown {
  if (section === 'tailwindCSS') return tailwindSettings
  if (section?.startsWith('tailwindCSS.')) {
    return section
      .slice('tailwindCSS.'.length)
      .split('.')
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | null | undefined)?.[key],
        tailwindSettings
      )
  }
  if (section === 'editor') return { tabSize: 2 }
  return null
}

function handleServerRequest(message: JsonRpcMessage): void {
  if (message.id === undefined || !message.method) return

  switch (message.method) {
    case 'workspace/configuration': {
      const { items } = message.params as ConfigurationParams
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

  if (message.id !== undefined) {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
    return
  }

  if (message.method === 'textDocument/publishDiagnostics') {
    const { uri, diagnostics } = message.params as PublishedDiagnosticsParams
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
    handleMessage(JSON.parse(body) as JsonRpcMessage)
  }
}

async function waitForDiagnostics(expectedUris: readonly string[]): Promise<void> {
  const timeoutAt = Date.now() + 30_000

  while (Date.now() < timeoutAt) {
    const allPublished = expectedUris.every((uri) => publishedUris.has(uri))
    const settled = allPublished && Date.now() - lastDiagnosticsAt >= 500
    if (settled) return
    await delay(100)
  }

  const missing = expectedUris.filter((uri) => !publishedUris.has(uri))
  throw new Error(
    `Timed out waiting for Tailwind diagnostics (${publishedUris.size}/${expectedUris.length} documents; missing ${missing.length})`
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

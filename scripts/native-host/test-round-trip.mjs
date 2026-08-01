import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const hostPath = resolve(process.argv[2] ?? '')
assert.ok(hostPath, 'native host path is required')

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tab-out-native-bridge-'))
const environment = {
  ...process.env,
  TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH: join(temporaryDirectory, 'bridge.sock')
}
const host = spawn(hostPath, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], {
  env: environment,
  stdio: ['pipe', 'pipe', 'pipe']
})

let nativeBuffer = Buffer.alloc(0)
let hostError = ''
host.stderr.on('data', (chunk) => { hostError += chunk })
host.stdout.on('data', (chunk) => {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk])
  if (nativeBuffer.length < 4) return
  const messageLength = nativeBuffer.readUInt32LE(0)
  if (nativeBuffer.length < messageLength + 4) return

  const request = JSON.parse(nativeBuffer.subarray(4, messageLength + 4).toString('utf8'))
  const response = Buffer.from(JSON.stringify({
    version: 1,
    type: 'response',
    requestId: request.requestId,
    status: 'accepted'
  }))
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(response.length)
  host.stdin.write(Buffer.concat([prefix, response]))
})

try {
  const socketPath = environment.TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(socketPath)
      break
    } catch {
      if (host.exitCode !== null) {
        throw new Error(`native host exited before creating its socket (exit ${host.exitCode}): ${hostError}`)
      }
      if (attempt === 199) throw new Error(`native host did not create its socket within 10 seconds: ${hostError}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }
  const request = JSON.stringify({
    version: 1,
    type: 'status',
    requestId: 'integration-round-trip',
    expiresAtMs: Date.now() + 5_000
  })
  const client = spawn(hostPath, ['--request', request], { env: environment })
  let clientOutput = ''
  let clientError = ''
  client.stdout.on('data', (chunk) => { clientOutput += chunk })
  client.stderr.on('data', (chunk) => { clientError += chunk })
  const clientExitCode = await new Promise((resolvePromise) => client.on('close', resolvePromise))

  assert.equal(clientExitCode, 0, clientError)
  assert.deepEqual(JSON.parse(clientOutput), {
    version: 1,
    type: 'response',
    requestId: 'integration-round-trip',
    status: 'accepted'
  })
} finally {
  if (host.exitCode === null) {
    host.stdin.end()
    await new Promise((resolvePromise) => host.on('close', resolvePromise))
  }
  await rm(temporaryDirectory, { recursive: true, force: true })
}

assert.equal(hostError, '')

const handoffDirectory = await mkdtemp(join(tmpdir(), 'tab-out-native-bridge-handoff-'))
const handoffEnvironment = {
  ...process.env,
  TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH: join(handoffDirectory, 'bridge.sock')
}
const handoffHost = spawn(hostPath, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], {
  env: handoffEnvironment,
  stdio: ['pipe', 'pipe', 'pipe']
})
const handoffHostClosed = new Promise((resolvePromise) => handoffHost.on('close', resolvePromise))
let handoffHostError = ''
handoffHost.stderr.on('data', (chunk) => { handoffHostError += chunk })
let replacementServer

try {
  const socketPath = handoffEnvironment.TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(socketPath)
      break
    } catch {
      if (handoffHost.exitCode !== null) {
        throw new Error(`native host exited before creating its handoff socket (exit ${handoffHost.exitCode}): ${handoffHostError}`)
      }
      if (attempt === 199) throw new Error(`native host did not create its handoff socket within 10 seconds: ${handoffHostError}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }

  await unlink(socketPath)
  replacementServer = createServer()
  await new Promise((resolvePromise, rejectPromise) => {
    replacementServer.once('error', rejectPromise)
    replacementServer.listen(socketPath, resolvePromise)
  })

  handoffHost.stdin.end()
  await handoffHostClosed
  await access(socketPath)
} finally {
  if (handoffHost.exitCode === null) {
    handoffHost.stdin.end()
    await handoffHostClosed
  }
  if (replacementServer?.listening) {
    await new Promise((resolvePromise) => replacementServer.close(resolvePromise))
  }
  await rm(handoffDirectory, { recursive: true, force: true })
}

assert.equal(handoffHostError, '')

const overflowClient = spawn(hostPath, ['--request', JSON.stringify({
  version: 1,
  type: 'status',
  requestId: 'deadline-overflow',
  expiresAtMs: 1e100
})], { env: environment })
let overflowError = ''
overflowClient.stderr.on('data', (chunk) => { overflowError += chunk })
const overflowResult = await new Promise((resolvePromise) => {
  overflowClient.on('close', (code, signal) => resolvePromise({ code, signal }))
})

assert.deepEqual(overflowResult, { code: 1, signal: null }, overflowError)
assert.match(overflowError, /deadline is too far in the future/)
console.log('native bridge round trip: ok')

import { Schema } from 'effect'

const jsonRpcErrorSchema = Schema.Struct({
  message: Schema.String,
})

const jsonRpcMessageSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(jsonRpcErrorSchema),
})

const configurationParamsSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    section: Schema.optionalKey(Schema.String),
  })),
})

const diagnosticSchema = Schema.Struct({
  range: Schema.Struct({
    start: Schema.Struct({
      line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
  severity: Schema.optionalKey(Schema.Int),
  code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.String,
})

const publishedDiagnosticsParamsSchema = Schema.Struct({
  uri: Schema.String,
  diagnostics: Schema.Array(diagnosticSchema),
})

const unknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

const isJsonRpcMessage = Schema.is(jsonRpcMessageSchema)
const isConfigurationParams = Schema.is(configurationParamsSchema)
const isPublishedDiagnosticsParams = Schema.is(publishedDiagnosticsParamsSchema)
export const isUnknownRecord = Schema.is(unknownRecordSchema)

export type JsonRpcMessage = typeof jsonRpcMessageSchema.Type
export type ConfigurationParams = typeof configurationParamsSchema.Type
export type Diagnostic = typeof diagnosticSchema.Type
export type PublishedDiagnosticsParams = typeof publishedDiagnosticsParamsSchema.Type

export function parseJsonRpcMessage(body: string): JsonRpcMessage {
  const value: unknown = JSON.parse(body)
  if (!isJsonRpcMessage(value)) {
    throw new TypeError('Tailwind language server returned an invalid JSON-RPC message')
  }
  return value
}

export function requireConfigurationParams(value: unknown): ConfigurationParams {
  if (!isConfigurationParams(value)) {
    throw new TypeError('Tailwind language server sent invalid workspace configuration parameters')
  }
  return value
}

export function requirePublishedDiagnosticsParams(value: unknown): PublishedDiagnosticsParams {
  if (!isPublishedDiagnosticsParams(value)) {
    throw new TypeError('Tailwind language server published invalid diagnostics')
  }
  return value
}

/**
 * Config projection shared by the patch rows and the project file: raw row
 * values (where `!!js` expressions arrive as `{__jsExpr}` objects, the harness
 * dialect's parse result) become masked wire views, and wire views become
 * storable YAML payloads — masked (`null`) secrets fall back to the stored
 * value, `!!js ` strings become tagged scalars again.
 */

import { Scalar } from 'yaml'
import type { McpConfigView } from './types.ts'

const JS_TAG = 'tag:yaml.org,2002:js'
const SECRET_KEY = /KEY|PASSWORD|SECRET|TOKEN/i

/** Marker object the harness js-yaml dialect yields for `!!js` scalars. */
export interface JsExpr {
  readonly __jsExpr: string
}

/** Test whether one raw config value is a `!!js` expression marker. */
export function isJsExpr(value: unknown): value is JsExpr {
  if (typeof value !== 'object' || value === null) return false
  const expr = (value as { __jsExpr?: unknown }).__jsExpr
  return typeof expr === 'string'
}

/** Project one raw row config into a display/masking view. */
export function viewConfig(raw: unknown): McpConfigView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const display = (value: unknown): string | null => {
    if (typeof value === 'string') return value
    if (isJsExpr(value)) return `!!js ${value.__jsExpr}`
    return null
  }
  const maskRecord = (value: unknown): Record<string, string | null> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const masked: Record<string, string | null> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      masked[key] = SECRET_KEY.test(key) ? null : display(entry)
    }
    return masked
  }
  const transport = record.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') return undefined
  return {
    transport,
    serverName: typeof record.serverName === 'string' ? record.serverName : '',
    command: display(record.command) ?? undefined,
    args: Array.isArray(record.args) && record.args.every(arg => typeof arg === 'string') ? record.args as string[] : undefined,
    cwd: display(record.cwd) ?? undefined,
    env: maskRecord(record.env),
    url: display(record.url) ?? undefined,
    headers: maskRecord(record.headers),
    toolCallTimeoutMs: typeof record.toolCallTimeoutMs === 'number' ? record.toolCallTimeoutMs : undefined,
    failOnStartupError: typeof record.failOnStartupError === 'boolean' ? record.failOnStartupError : undefined,
  }
}

/** A non-empty string field of one raw config. */
export function configText(config: unknown, key: string): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const value = (config as Record<string, unknown>)[key]
  if (typeof value === 'string' && value !== '') return value
  return undefined
}

/**
 * Turn a wire view into the raw payload for storage: masked (`null`) secret
 * values keep whatever the existing raw config holds (including `!!js`
 * markers), and everything else copies through.
 */
export function storedPayload(view: McpConfigView, existingRaw: unknown): Record<string, unknown> {
  const existing = typeof existingRaw === 'object' && existingRaw !== null ? existingRaw as Record<string, unknown> : {}
  const mergedRecord = (incoming: Readonly<Record<string, string | null>> | undefined,
    currentKey: 'env' | 'headers'): Record<string, unknown> | undefined => {
    if (incoming === undefined) return undefined
    const current = typeof existing[currentKey] === 'object' && existing[currentKey] !== null
      ? existing[currentKey] as Record<string, unknown>
      : {}
    const merged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = value ?? current[key] ?? ''
    }
    return merged
  }
  const payload: Record<string, unknown> = { serverName: view.serverName, transport: view.transport }
  if (view.transport === 'stdio') {
    payload.command = view.command ?? ''
    if (view.args !== undefined && view.args.length > 0) payload.args = [...view.args]
    if (view.cwd !== undefined && view.cwd !== '') payload.cwd = view.cwd
    const env = mergedRecord(view.env, 'env')
    if (env !== undefined && Object.keys(env).length > 0) payload.env = env
  } else {
    payload.url = view.url ?? ''
    const headers = mergedRecord(view.headers, 'headers')
    if (headers !== undefined && Object.keys(headers).length > 0) payload.headers = headers
  }
  if (view.toolCallTimeoutMs !== undefined) payload.toolCallTimeoutMs = view.toolCallTimeoutMs
  if (view.failOnStartupError !== undefined) payload.failOnStartupError = view.failOnStartupError
  return payload
}

/** Map `!!js `-prefixed strings and `{__jsExpr}` markers to tagged expression scalars, recursively. */
export function tagExpressions(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('!!js ')) {
    return jsScalar(value.slice(5))
  }
  if (isJsExpr(value)) {
    return jsScalar(value.__jsExpr)
  }
  if (Array.isArray(value)) return value.map(tagExpressions)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, tagExpressions(entry)]))
  }
  return value
}

/** Build one `!!js` tagged scalar node. */
export function jsScalar(expression: string): Scalar {
  const scalar = new Scalar(expression)
  scalar.tag = JS_TAG
  return scalar
}

export { JS_TAG, SECRET_KEY }

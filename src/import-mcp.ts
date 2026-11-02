/**
 * mcpServers document conversion (DESIGN.md §7.1/§7.3). Import parses a
 * Claude / Cursor / Cline / Roo / VS Code configuration tolerantly — JSONC
 * comments and trailing commas, top-level `mcpServers` or a bare mapping —
 * and converts every entry into a dsh wire config: `${VAR}` and
 * `${env:VAR}` become `!!js process.env.VAR` expressions (backtick templates
 * when embedded), `${input:…}` placeholders are collected for the wizard
 * form. Export inverts stored raw configs back into the standard document,
 * rendering `!!js process.env.X` as `${X}`.
 */

import { isJsExpr } from './config-view.ts'
import type { ImportInput, ImportPreview, ImportPreviewEntry, McpConfigView } from './types.ts'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ENV_WHOLE = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/
const ENV_ANY = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}/
const ENV_ALL = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g
const INPUT_ALL = /\$\{input:([^}]*)\}/g

/** A mutable projection of the wire config while one entry is assembled. */
type MutableConfig = { -readonly [K in keyof McpConfigView]: McpConfigView[K] }

/** Convert one source document into preview entries; throws on document-level failures. */
export function convertMcpImport(text: string): ImportPreview {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error('the document must be a JSON object')
  }
  let servers: Record<string, unknown>
  if (isRecord(parsed.mcpServers)) {
    servers = parsed.mcpServers
  } else if (parsed.mcpServers === undefined) {
    const values = Object.values(parsed)
    if (values.length > 0 && values.every(value => isRecord(value) && !Array.isArray(value))) servers = parsed
    else throw new Error('expected a top-level "mcpServers" object or a bare server mapping')
  } else {
    throw new Error('"mcpServers" must be an object')
  }

  // VS Code `inputs` array: promptString metadata for `${input:…}` references.
  const inputMeta = new Map<string, ImportInput>()
  if (Array.isArray(parsed.inputs)) {
    for (const item of parsed.inputs) {
      if (!isRecord(item) || typeof item.id !== 'string') continue
      inputMeta.set(item.id, {
        id: item.id,
        ...(typeof item.description === 'string' && item.description !== '' ? { description: item.description } : {}),
        ...(item.password === true ? { password: true } : {}),
      })
    }
  }

  const entries: ImportPreviewEntry[] = []
  const errors: string[] = []
  for (const [key, value] of Object.entries(servers)) {
    if (!isRecord(value) || Array.isArray(value)) {
      errors.push(`${key}: entry must be an object`)
      continue
    }
    const converted = convertEntry(key, value, inputMeta)
    if (converted.kind === 'error') errors.push(`${key}: ${converted.message}`)
    else entries.push(converted.entry)
  }
  return { entries, errors }
}

/** JSON.parse with a JSONC fallback (VS Code mcp.json allows comments / trailing commas). */
function parseJson(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, '').trim()
  if (stripped === '') throw new Error('the document is empty')
  try {
    return JSON.parse(stripped)
  } catch {
    // fall through to the tolerant pass
  }
  try {
    return JSON.parse(stripJsonc(stripped))
  } catch (error) {
    throw new Error(`not a valid JSON document: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Strip line/block comments and trailing commas; string contents stay intact. */
function stripJsonc(text: string): string {
  let out = ''
  let index = 0
  let quote = ''
  while (index < text.length) {
    const char = text[index]
    const next = index + 1 < text.length ? text[index + 1] : ''
    if (quote !== '') {
      if (char === '\\' && next !== '') {
        out += char + next
        index += 2
        continue
      }
      if (char === quote) quote = ''
      out += char
      index += 1
      continue
    }
    if (char === '"') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index = Math.min(index + 2, text.length)
      continue
    }
    if (char === '}' || char === ']') out = out.replace(/,(\s*)$/, '$1')
    out += char
    index += 1
  }
  return out
}

/** Convert one server entry; non-fatal issues land in `warnings`. */
function convertEntry(
  key: string,
  value: Record<string, unknown>,
  inputMeta: ReadonlyMap<string, ImportInput>,
): { kind: 'ok'; entry: ImportPreviewEntry } | { kind: 'error'; message: string } {
  const warnings: string[] = []
  const inputs = new Map<string, ImportInput>()

  const type = typeof value.type === 'string' ? value.type : undefined
  const knownType = type === 'stdio' || type === 'http' || type === 'sse' || type === 'streamable-http'
  if (type !== undefined && !knownType) warnings.push(`ignored unknown type "${type}"`)
  if (type === 'sse') warnings.push('sse transport: dsh only supports streamable-http, this server may not connect')

  const command = typeof value.command === 'string' && value.command !== '' ? value.command : undefined
  const url = typeof value.url === 'string' && value.url !== '' ? value.url : undefined
  const wantsHttp = type === 'http' || type === 'sse' || type === 'streamable-http'
  let transport: 'stdio' | 'streamable-http'
  if (wantsHttp && url !== undefined) transport = 'streamable-http'
  else if (command !== undefined) transport = 'stdio'
  else if (url !== undefined) {
    transport = 'streamable-http'
    warnings.push('no command; inferred http transport from url')
  } else {
    return { kind: 'error', message: 'entry has neither a command nor a url' }
  }

  const config: MutableConfig = { transport, serverName: key }
  const convertRecord = (record: unknown): Record<string, string> | undefined => {
    if (!isRecord(record)) return undefined
    const out: Record<string, string> = {}
    for (const [name, raw] of Object.entries(record)) {
      out[name] = convertValue(typeof raw === 'string' ? raw : String(raw), warnings, inputs, inputMeta)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  if (transport === 'stdio') {
    config.command = convertValue(command ?? '', warnings, inputs, inputMeta)
    if (Array.isArray(value.args)) {
      const args = value.args.map(arg => convertValue(typeof arg === 'string' ? arg : String(arg), warnings, inputs, inputMeta))
      if (args.length > 0) config.args = args
    }
    if (typeof value.cwd === 'string' && value.cwd !== '') {
      config.cwd = convertValue(value.cwd, warnings, inputs, inputMeta)
    }
    config.env = convertRecord(value.env)
  } else {
    config.url = convertValue(url ?? '', warnings, inputs, inputMeta)
    config.headers = convertRecord(value.headers)
  }
  if (typeof value.toolCallTimeoutMs === 'number' && Number.isInteger(value.toolCallTimeoutMs) && value.toolCallTimeoutMs > 0) {
    config.toolCallTimeoutMs = value.toolCallTimeoutMs
  }
  if (typeof value.failOnStartupError === 'boolean') config.failOnStartupError = value.failOnStartupError

  let name = key
  let renamed = false
  if (!SERVER_NAME.test(name)) {
    const slug = slugify(name)
    if (!SERVER_NAME.test(slug)) return { kind: 'error', message: `cannot derive a valid server name from "${key}"` }
    warnings.push(`renamed "${key}" to "${slug}" to satisfy the server-name grammar`)
    name = slug
    renamed = true
  }
  config.serverName = name
  return {
    kind: 'ok',
    entry: {
      name,
      originalName: key,
      ...(renamed ? { renamed: true } : {}),
      transport,
      config,
      warnings,
      inputs: [...inputs.values()],
    },
  }
}

/**
 * Replace `${VAR}` / `${env:VAR}` references with `!!js` expressions. Values
 * that also reference `${input:…}` placeholders keep their literal text —
 * the wizard substitutes those, and mixing the two needs a manual pass.
 */
function convertValue(
  text: string,
  warnings: string[],
  inputs: Map<string, ImportInput>,
  inputMeta: ReadonlyMap<string, ImportInput>,
): string {
  let referencesInput = false
  const withInputs = text.replace(INPUT_ALL, (_match, id: string) => {
    referencesInput = true
    if (!inputs.has(id)) inputs.set(id, inputMeta.get(id) ?? { id })
    return _match
  })
  if (!ENV_ANY.test(withInputs)) return withInputs
  if (referencesInput) {
    warnings.push(`"${withInputs}" mixes \${input:} placeholders with env references; adjust it manually after import`)
    return withInputs
  }
  const whole = ENV_WHOLE.exec(withInputs)
  if (whole !== null) return `!!js process.env.${whole[1]}`
  const template = withInputs.replace(ENV_ALL, '${process.env.$1}').replace(/`/g, '\\`')
  return `!!js \`${template}\``
}

/** Lowercase, separator-collapse, and trim one candidate name. */
function slugify(key: string): string {
  return key.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
}

/** Project one stored raw config into the standard mcpServers entry shape. */
export function exportMcpEntry(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  const dollar = (value: unknown): unknown => {
    if (isJsExpr(value)) return exprToDollar(value.__jsExpr)
    if (Array.isArray(value)) return value.map(dollar)
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, dollar(entry)]))
    return value
  }
  const present = (value: unknown): boolean => value !== undefined && value !== null
  if (raw.transport === 'stdio') {
    const out: Record<string, unknown> = {}
    if (present(raw.command)) out.command = dollar(raw.command)
    if (present(raw.args)) out.args = dollar(raw.args)
    if (present(raw.env)) out.env = dollar(raw.env)
    if (typeof raw.cwd === 'string' && raw.cwd !== '') out.cwd = dollar(raw.cwd)
    return out.command === undefined ? undefined : out
  }
  if (raw.transport === 'streamable-http') {
    const out: Record<string, unknown> = { type: 'http' }
    if (present(raw.url)) out.url = dollar(raw.url)
    if (present(raw.headers)) out.headers = dollar(raw.headers)
    return out.url === undefined ? undefined : out
  }
  return undefined
}

/** `process.env.NAME` → `${NAME}`; backtick templates keep their interpolation holes. */
function exprToDollar(expr: string): string {
  const whole = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr)
  if (whole !== null) return `\${${whole[1]}}`
  if (expr.startsWith('`') && expr.endsWith('`')) {
    return expr.slice(1, -1)
      .replace(/\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, '\${$1}')
      .replace(/\\`/g, '`')
  }
  return expr
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

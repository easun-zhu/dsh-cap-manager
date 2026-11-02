/**
 * The project-level MCP file `<projectRoot>/.dsh/mcp.yml` (DESIGN.md §5.3): a
 * `mcpServers` mapping whose entries are dsh mcp-client config fields plus an
 * `enabled` flag. The file is the only source of truth; the ProjectMounter
 * derives live fibers from it. Comment-preserving edits follow the patch
 * writer's discipline (lock → backup → atomic write), and `!!js` expressions
 * round-trip through the same `{__jsExpr}` marker as the harness dialect.
 */

import { copyFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isScalar, isSeq, parseDocument, YAMLMap, type Document } from 'yaml'
import { isJsExpr, JS_TAG, storedPayload, tagExpressions, viewConfig, type JsExpr } from './config-view.ts'
import type { McpConfigView } from './types.ts'

const BACKUP_KEEP = 5
const BACKUP_PREFIX = '.cap-bak-'
const ENV_REFERENCE = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/
const TEMPLATE_PIECE = /\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Failures carrying the `cap/yaml-invalid` wire code. */
export class ProjectConfigError extends Error {}

/** Path of one project's MCP file. */
export function projectMcpPath(root: string): string {
  return join(root, '.dsh', 'mcp.yml')
}

/** One server entry of the parsed project file. */
export interface ProjectServerEntry {
  readonly serverName: string
  readonly enabled: boolean
  /** Masked wire view; undefined when the entry is structurally unreadable. */
  readonly view: McpConfigView | undefined
  /** Raw config (with `!!js` markers) as stored; export needs unmasked values. */
  readonly raw: Record<string, unknown> | undefined
  /** Evaluated plain config for mounting; undefined when an expression failed. */
  readonly plain: Record<string, unknown> | undefined
  /** Why `plain` could not be produced, when it failed. */
  readonly evalError: string | undefined
}

/** Parse outcome of one project file: entry list or the file-level failure. */
export interface ProjectFileState {
  readonly servers: readonly ProjectServerEntry[]
  /** File-level YAML/shape error, when the file exists but cannot be read. */
  readonly error: string | undefined
}

/** Read and parse one project file; a missing file is an empty, healthy state. */
export async function readProjectMcp(root: string): Promise<ProjectFileState> {
  const file = projectMcpPath(root)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], error: undefined }
    throw error
  }
  try {
    return { servers: parseServers(text), error: undefined }
  } catch (error) {
    if (error instanceof ProjectConfigError) return { servers: [], error: error.message }
    throw error
  }
}

/** Parse the `mcpServers` mapping into entries, evaluating `!!js` expressions. */
function parseServers(text: string): ProjectServerEntry[] {
  const document = parseDocument(text, {
    customTags: [{ tag: JS_TAG, resolve: (value: string) => ({ __jsExpr: value }) }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw new ProjectConfigError(`project mcp.yml has a YAML error: ${error.message}`)
  const contents = document.contents
  if (contents === null || (isScalar(contents) && contents.value === null)) return []
  if (!isMap(contents)) throw new ProjectConfigError('project mcp.yml must be a YAML mapping')
  const serversNode = contents.get('mcpServers', true)
  if (serversNode === undefined || (isScalar(serversNode) && serversNode.value === null)) return []
  if (!isMap(serversNode)) throw new ProjectConfigError('mcpServers must be a mapping')
  const entries: ProjectServerEntry[] = []
  for (const pair of (serversNode as YAMLMap).items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined
    if (key === undefined || key === '') continue
    const body = pair.value
    if (body === undefined || (isScalar(body) && body.value === null)) continue
    if (!isMap(body)) throw new ProjectConfigError(`mcpServers.${key} must be a mapping`)
    const raw = rawValue(body) as Record<string, unknown>
    const view = viewConfig(raw)
    const enabled = body.get('enabled') !== false
    // The mapping key IS the server name; inject it so evaluation yields a complete config.
    const evaluated = view === undefined
      ? { value: undefined, error: undefined }
      : evaluateConfig({ ...raw, serverName: key })
    entries.push({
      serverName: key,
      enabled,
      view: view === undefined ? undefined : { ...view, serverName: key },
      raw,
      plain: evaluated.value,
      evalError: evaluated.error,
    })
  }
  return entries
}

/** Plain JS projection of one YAML node with `!!js` scalars kept as markers. */
function rawValue(node: unknown): unknown {
  if (isScalar(node)) {
    return node.tag === JS_TAG ? { __jsExpr: String(node.value) } : node.value
  }
  if (isSeq(node)) return node.items.map(rawValue)
  if (isMap(node)) {
    const record: Record<string, unknown> = {}
    for (const pair of node.items) {
      record[isScalar(pair.key) ? String(pair.key.value) : String(pair.key)] = rawValue(pair.value)
    }
    return record
  }
  return node
}

interface Evaluated {
  readonly value: Record<string, unknown> | undefined
  readonly error: string | undefined
}

/** Evaluate every `!!js` expression of one raw config into literal values. */
function evaluateConfig(raw: Record<string, unknown>): Evaluated {
  try {
    const payload: Record<string, unknown> = { serverName: raw.serverName, transport: raw.transport }
    if (raw.transport === 'stdio') {
      payload.command = expectString(raw.command, 'command')
      if (Array.isArray(raw.args)) payload.args = raw.args.map((arg, at) => expectString(arg, `args[${at}]`))
      if (raw.cwd !== undefined) payload.cwd = expectString(raw.cwd, 'cwd')
      payload.env = evaluateRecord(raw.env, 'env')
    } else {
      payload.url = expectString(raw.url, 'url')
      payload.headers = evaluateRecord(raw.headers, 'headers')
    }
    if (raw.toolCallTimeoutMs !== undefined) payload.toolCallTimeoutMs = raw.toolCallTimeoutMs
    if (raw.failOnStartupError !== undefined) payload.failOnStartupError = raw.failOnStartupError
    return { value: payload, error: undefined }
  } catch (error) {
    return { value: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value === 'string') return value
  if (isJsExpr(value)) return evaluateString(value, field)
  throw new ProjectConfigError(`${field} must be a string`)
}

function evaluateRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectConfigError(`${field} must be a mapping`)
  }
  const evaluated: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    evaluated[key] = expectString(entry, `${field}.${key}`)
  }
  return evaluated
}

/**
 * Evaluate one `!!js` expression. Only `process.env.NAME` references and
 * backtick templates interpolating them are supported (no evaluation of
 * arbitrary code); an unset variable is an error so misconfiguration surfaces
 * at mount time instead of as an empty credential.
 */
function evaluateString(expr: JsExpr, field: string): string {
  const source = expr.__jsExpr
  const reference = ENV_REFERENCE.exec(source)
  if (reference !== null) {
    const value = process.env[reference[1]]
    if (value === undefined) throw new ProjectConfigError(`${field}: environment variable ${reference[1]} is not set`)
    return value
  }
  if (source.startsWith('`') && source.endsWith('`')) {
    let resolved = ''
    let cursor = 0
    for (const match of source.matchAll(TEMPLATE_PIECE)) {
      const at = match.index ?? 0
      const value = process.env[match[1]]
      if (value === undefined) {
        throw new ProjectConfigError(`${field}: environment variable ${match[1]} is not set`)
      }
      resolved += `${source.slice(cursor, at)}${value}`
      cursor = at + match[0].length
    }
    return resolved + source.slice(cursor).replace(/\\`/g, '`').replace(/\\\$/g, '$')
  }
  throw new ProjectConfigError(
    `${field}: unsupported !!js expression (supported: process.env.NAME and template literals interpolating it)`,
  )
}

// ---- Structured edits ----

function parseFile(text: string): { document: Document.Parsed; root: YAMLMap } {
  const document = parseDocument(text, {
    customTags: [{ tag: JS_TAG, resolve: (value: string) => ({ __jsExpr: value }) }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw new ProjectConfigError(`project mcp.yml has a YAML error: ${error.message}`)
  if (!isMap(document.contents)) throw new ProjectConfigError('project mcp.yml must be a YAML mapping')
  return { document, root: document.contents }
}

/** The `mcpServers` mapping node, created (with a header comment) when absent. */
function ensureServersMap(root: YAMLMap): YAMLMap {
  const existing = root.get('mcpServers', true)
  if (isMap(existing)) return existing as YAMLMap
  if (existing !== undefined) throw new ProjectConfigError('mcpServers must be a mapping')
  const created = new YAMLMap()
  created.commentBefore = 'Managed by dsh-cap-manager; hand edits are picked up live.'
  root.set('mcpServers', created)
  return created
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function backup(file: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(file, `${file}${BACKUP_PREFIX}${stamp}`)
    const base = basename(file)
    const backups = (await readdir(dirname(file)))
      .filter(name => name.startsWith(`${base}${BACKUP_PREFIX}`))
      .sort()
    for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
      await unlink(join(dirname(file), name)).catch(() => undefined)
    }
  } catch {
    // A failed history copy never blocks the edit; the atomic write still lands.
  }
}

/** Run one edit under the file lock; commit only when the document changed. */
async function edit(root: string, change: (document: Document.Parsed, servers: YAMLMap) => boolean): Promise<boolean> {
  const file = projectMcpPath(root)
  return await withFileLock(file, async () => {
    const before = await readText(file)
    const { document, root: rootNode } = parseFile(before ?? '# Managed by dsh-cap-manager; hand edits are picked up live.\n{}\n')
    const servers = ensureServersMap(rootNode)
    const changed = change(document, servers)
    if (!changed) return false
    if (before !== undefined) await backup(file)
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, String(document), { mode: 0o600 })
    return true
  })
}

/** Insert or replace one server entry by name; always counts as a change. */
export function writeProjectServer(root: string, config: McpConfigView, enabled: boolean): Promise<boolean> {
  return edit(root, (document, servers) => {
    const existingNode = servers.get(config.serverName, true)
    const existingRaw = isMap(existingNode) ? rawValue(existingNode) : undefined
    const payload = storedPayload(config, existingRaw)
    const entry = document.createNode(tagExpressions(payload)) as YAMLMap
    if (!enabled) entry.set('enabled', false)
    servers.set(config.serverName, entry)
    return true
  })
}

/** Remove one server entry. Returns whether the file changed. */
export function removeProjectServer(root: string, serverName: string): Promise<boolean> {
  return edit(root, (_document, servers) => {
    if (!servers.has(serverName)) return false
    servers.delete(serverName)
    return true
  })
}

/** Flip the literal `enabled` flag of one server entry. */
export function setProjectServerEnabled(root: string, serverName: string, enabled: boolean): Promise<boolean> {
  return edit(root, (_document, servers) => {
    const node = servers.get(serverName, true)
    if (!isMap(node)) return false
    if (enabled) {
      if (node.get('enabled') !== false) return false
      node.delete('enabled')
    } else {
      if (node.get('enabled') === false) return false
      node.set('enabled', false)
    }
    return true
  })
}

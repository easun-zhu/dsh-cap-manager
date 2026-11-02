/**
 * Adapter deriving per-server live status: loader fiber states plus the
 * `mcp__<serverName>__*` tool population from the tools registry.
 *
 * Upstream API references for this plugin concentrate here (DESIGN.md §11):
 * ctx.loader.entries() fiber states and ctx.tools.definitions(). Cordis
 * `Fiber.state` is the numeric FiberState enum (PENDING=0 … UNLOADING=5), so
 * both numeric and (defensively) legacy-string states map to one name; the
 * startup error lives in the fiber's private `_error`, read structurally.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpStatus } from './types.ts'

/** Structural view of a Cordis fiber as reachable from loader entries or ctx.plugin(). */
export interface FiberLike {
  readonly state?: number | string
  readonly _error?: unknown
}

/** Structural view of one loader entry row. */
interface LoaderEntryLike {
  readonly id: string
  readonly fiber?: FiberLike
}

/** Structural view of the loader registry service. */
interface LoaderLike {
  entries(): readonly LoaderEntryLike[]
}

/** Structural view of one registered tool definition. */
interface ToolDefinitionLike {
  readonly name: string
}

/** Structural view of the tools registry service. */
interface ToolsLike {
  definitions(): readonly ToolDefinitionLike[]
}

/** Live facts for one MCP server, before status resolution. */
export interface RowFacts {
  readonly fiberState: string | undefined
  readonly fiberError: string | undefined
  /** Registered tool count; undefined when the runtime exposes no tool listing. */
  readonly toolCount: number | undefined
}

/** Normalize a cordis FiberState (numeric enum or string) to one name. */
function stateName(state: number | string | undefined): string | undefined {
  switch (state) {
    case 0: case 'pending': return 'pending'
    case 1: case 'loading': return 'loading'
    case 2: case 'active': return 'active'
    case 3: case 'failed': return 'failed'
    case 4: case 'disposed': return 'disposed'
    case 5: case 'unloading': return 'unloading'
    default: return typeof state === 'string' ? state : undefined
  }
}

/** Count registered `mcp__<serverName>__*` tools for the given names; undefined when the runtime's tools service has no listing API (0.2.1-rc.x). */
export function collectToolCounts(ctx: Context, serverNames: readonly string[]): Map<string, number> | undefined {
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools === undefined || typeof tools.definitions !== 'function') return undefined
  const counts = new Map<string, number>(serverNames.map(name => [name, 0]))
  for (const definition of tools.definitions()) {
    const match = /^mcp__([A-Za-z0-9_-]{1,32})__/.exec(definition.name)
    if (match === null) continue
    const current = counts.get(match[1])
    if (current !== undefined) counts.set(match[1], current + 1)
  }
  return counts
}

/** Facts of one directly held fiber (project mounts); tool count supplied by the caller. */
export function fiberFacts(fiber: FiberLike, toolCount: number | undefined): RowFacts {
  return {
    fiberState: stateName(fiber.state),
    fiberError: errorMessage(fiber._error),
    toolCount,
  }
}

/** Collect fiber state and tool counts for the given server ids and names. */
export function collectRowFacts(ctx: Context, rows: readonly { id: string; serverName: string }[]): Map<string, RowFacts> {
  const facts = new Map<string, RowFacts>()

  const loader = ctx.get('loader') as LoaderLike | undefined
  const states = new Map<string, { state: string | undefined; error: string | undefined }>()
  if (loader !== undefined) {
    for (const entry of loader.entries()) {
      states.set(entry.id, {
        state: stateName(entry.fiber?.state),
        error: errorMessage(entry.fiber?._error),
      })
    }
  }

  const toolCounts = collectToolCounts(ctx, rows.map(row => row.serverName))
  for (const row of rows) {
    const state = states.get(row.id)
    facts.set(row.id, {
      fiberState: state?.state,
      fiberError: state?.error,
      toolCount: toolCounts?.get(row.serverName),
    })
  }
  return facts
}

/** Resolve the display status of one row from its facts and enabled flag. */
export function resolveStatus(enabled: boolean, facts: RowFacts | undefined): McpStatus {
  if (!enabled) return 'disabled'
  if (facts === undefined) return 'stopped'
  // Without a tool listing (0.2.1-rc.x) the fiber state alone decides.
  switch (facts.fiberState) {
    case 'active': return facts.toolCount === undefined || facts.toolCount > 0 ? 'connected' : 'connecting'
    case 'failed': return 'failed'
    case 'loading': case 'pending': return 'connecting'
    case 'disposed': case 'unloading': return 'stopped'
    default: return facts.toolCount !== undefined && facts.toolCount > 0 ? 'connected' : 'stopped'
  }
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error !== '') return error
  return undefined
}

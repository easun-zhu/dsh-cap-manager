/**
 * Adapter over @deepseek-ai/dsh-app-boot composition reading: which MCP-client
 * rows exist, their merged config, and which file layer owns each row.
 *
 * Upstream API references for this plugin concentrate here (DESIGN.md §11):
 * readProfilePatches / composeEntries / loadOptionalPatches / ProfileContext.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  composeEntries,
  loadOptionalPatches,
  readProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import type { McpScope } from './types.ts'

const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Minimal structural view of one composed loader entry (EntryOptions). */
export interface CompositionRow {
  readonly id: string
  readonly name?: string
  readonly config?: Record<string, unknown> | unknown
  readonly disabled?: boolean
  readonly group?: unknown
}

/** Insert ids found in one patch file, or an empty set when the file is absent. */
function insertIdsOf(patchFile: string | undefined): Set<string> {
  if (patchFile === undefined || !existsSync(patchFile)) return new Set()
  const patches = loadOptionalPatches('dsh', patchFile) ?? []
  const ids = new Set<string>()
  for (const patch of patches) {
    const insert = (patch as { insert?: readonly { id?: unknown }[] }).insert
    if (insert === undefined) continue
    for (const row of insert) {
      if (typeof row.id === 'string') ids.add(row.id)
    }
  }
  return ids
}

/** Rows composed from every layer (bundles, profile, home, overlays), groups flattened. */
export function composedRows(profile: ProfileContext): CompositionRow[] {
  const patches = readProfilePatches('dsh', profile)
  // Group rows may nest child entries inside an array `config`; flatten like the
  // plugin-manager does before scanning (packages/boot/plugin-manager/src/patch.ts).
  const flat = (rows: readonly CompositionRow[]): CompositionRow[] =>
    rows.flatMap(row => [
      row,
      ...(row.group !== undefined && Array.isArray(row.config)
        ? flat(row.config as readonly CompositionRow[])
        : []),
    ])
  return flat(composeEntries([patches]) as unknown as readonly CompositionRow[])
}

/** Scope of one row id: home patch inserts are global, profile patch inserts are profile, the rest preset/bundle. */
export function scopeOf(id: string, profile: ProfileContext): McpScope {
  if (insertIdsOf(join(profile.home, PROFILE_PATCH_FILENAME)).has(id)) return 'global'
  if (insertIdsOf(profile.patchPath).has(id)) return 'profile'
  return 'preset'
}

/** Coerce a row config field to a display string without evaluating expressions. */
export function configText(config: unknown, key: string): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const value = (config as Record<string, unknown>)[key]
  if (typeof value === 'string' && value !== '') return value
  return undefined
}

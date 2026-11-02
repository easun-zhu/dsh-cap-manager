/**
 * Comment-preserving structured edits of cordis.patch.yml files (the profile
 * user layer and the global home layer). `!!js` expression scalars round-trip
 * through the same custom tag the harness dialect defines
 * (`tag:yaml.org,2002:js`, vendor/include/src/index.ts).
 *
 * Write path: parse → edit in memory → backup → atomic write, all under the
 * sibling file lock. Both target files are watched by dsh-hmr, so a committed
 * edit recomposes the running profile on its own; callers report
 * `restart-required` only when HMR is absent.
 */

import { copyFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, YAMLMap, type Document, type YAMLSeq } from 'yaml'
import { JS_TAG, tagExpressions } from './config-view.ts'

const BACKUP_KEEP = 5
const BACKUP_PREFIX = '.cap-bak-'

/** A whole-row payload for one mcp-client insert entry. */
export interface RowPayload {
  readonly id: string
  readonly name: string
  readonly config: Record<string, unknown>
}

/** Failures carrying the `cap/yaml-invalid` wire code. */
export class PatchFileError extends Error {}

/** Parse one patch file; rejects malformed documents before anything is edited. */
function parsePatch(text: string): { document: Document.Parsed; seq: YAMLSeq } {
  const document = parseDocument(text, {
    customTags: [{ tag: JS_TAG, resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw new PatchFileError(`patch file has a YAML error: ${error.message}`)
  if (!isSeq(document.contents)) throw new PatchFileError('patch file must be a YAML sequence')
  return { document, seq: document.contents }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** The insert-row YAMLMap carrying `id`, and its enclosing `- insert:` item. */
function findInsertRow(seq: YAMLSeq, id: string): { item: YAMLMap; list: YAMLMap | undefined } | undefined {
  for (const entry of seq.items) {
    if (!isMap(entry) || !entry.has('insert')) continue
    const insert = entry.get('insert', true)
    if (!isSeq(insert)) continue
    for (const row of insert.items) {
      if (isMap(row) && row.get('id') === id) return { item: row, list: entry }
    }
  }
  return undefined
}

/** The document's first `- insert:` item, created empty when absent. */
function ensureInsertList(document: Document.Parsed, seq: YAMLSeq): YAMLMap {
  for (const entry of seq.items) {
    if (isMap(entry) && entry.has('insert')) return entry
  }
  const created = new YAMLMap()
  created.set('insert', document.createNode([]))
  seq.add(created)
  return created
}

/** Build the row map node for one payload. */
function rowNode(document: Document.Parsed, payload: RowPayload): YAMLMap {
  return document.createNode(tagExpressions({
    id: payload.id,
    name: payload.name,
    config: payload.config,
  })) as YAMLMap
}

/** Keep the newest `.cap-bak-*` copies beside the target file; never blocks an edit. */
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
async function edit(file: string, change: (document: Document.Parsed, seq: YAMLSeq) => boolean): Promise<boolean> {
  return await withFileLock(file, async () => {
    const before = await readText(file)
    const { document, seq } = parsePatch(before ?? '[]\n')
    const changed = change(document, seq)
    if (!changed) return false
    if (before !== undefined) await backup(file)
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, String(document), { mode: 0o600 })
    return true
  })
}

/** Insert or replace one mcp-client row by id. Always counts as a change. */
export function upsertRow(file: string, payload: RowPayload, disabled: boolean | undefined): Promise<boolean> {
  return edit(file, (document, seq) => {
    const existing = findInsertRow(seq, payload.id)
    if (existing === undefined) {
      const listEntry = ensureInsertList(document, seq)
      const insert = listEntry.get('insert', true)
      if (isSeq(insert)) insert.add(rowNode(document, payload))
    } else {
      const comment = existing.item.commentBefore
      existing.item.items.length = 0
      if (comment !== undefined) existing.item.commentBefore = comment
      for (const pair of rowNode(document, payload).items) existing.item.add(pair)
    }
    const row = findInsertRow(seq, payload.id)
    if (row !== undefined) {
      if (disabled === true) row.item.set('disabled', true)
      else row.item.delete('disabled')
    }
    return true
  })
}

/** Remove one mcp-client insert row by id. Returns whether the file changed. */
export function removeRow(file: string, id: string): Promise<boolean> {
  return edit(file, (_document, seq) => {
    const found = findInsertRow(seq, id)
    if (found === undefined) return false
    const insert = found.list?.get('insert', true)
    if (isSeq(insert)) {
      const at = insert.items.indexOf(found.item)
      if (at >= 0) insert.delete(at)
      if (insert.items.length === 0 && found.list !== undefined) {
        const outerAt = seq.items.indexOf(found.list)
        if (outerAt >= 0) seq.delete(outerAt)
      }
    }
    
    return true
  })
}

/** Flip the literal `disabled` flag on one insert row. Returns whether the file changed. */
export function setRowEnabled(file: string, id: string, enabled: boolean): Promise<boolean> {
  return edit(file, (_document, seq) => {
    const found = findInsertRow(seq, id)
    if (found === undefined) return false
    if (enabled) {
      if (!found.item.has('disabled')) return false
      found.item.delete('disabled')
      return true
    }
    if (found.item.get('disabled') === true) return false
    found.item.set('disabled', true)
    return true
  })
}

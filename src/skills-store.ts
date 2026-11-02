/**
 * Skills storage (DESIGN.md §5.2/§6.6): scans the four writable skill roots
 * with the provider's own discovery rules (`<root>/<name>/SKILL.md` or
 * `<root>/<name>.md`, kebab-case names, the same frontmatter grammar), writes
 * comment-preserving SKILL.md edits (atomic + backup), and moves deletions
 * into the plugin's trash directory instead of destroying them. The
 * filesystem provider's watcher picks every write up live, so the catalog
 * refreshes on its own.
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, parseDocument, YAMLMap, type Document } from 'yaml'

/** Upstream skill-name grammar (`packages/skill/skill/src/index.ts:21`). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The upstream skill-name grammar, for callers validating import payloads. */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Canonical frontmatter keys, in write order. */
const KEY_NAME = 'name'
const KEY_DESCRIPTION = 'description'
const KEY_WHEN = 'whenToUse'
const KEY_DISABLE_MODEL = 'disable-model-invocation'
const KEY_USER_INVOCABLE = 'user-invocable'

/** The four writable roots (lower rank wins duplicates — upstream precedence). */
export type SkillScopeDir = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'

const SOURCE_RANK: Record<SkillScopeDir, number> = {
  'project-dsh': 100,
  'project-agents': 200,
  'user-dsh': 400,
  'user-agents': 500,
}

/** Caller-side failures carrying their wire code. */
export class SkillStoreError extends Error {
  readonly code: 'cap/invalid-config' | 'cap/name-conflict' | 'cap/not-found' | 'cap/readonly' | 'cap/yaml-invalid'
  constructor(message: string, code: SkillStoreError['code']) {
    super(message)
    this.code = code
  }
}

/** Home roots the scanner and writers need. */
export interface SkillHomes {
  readonly dshHome: string
  readonly agentsHome: string
  /** Present when project roots join the scan. */
  readonly projectRoot?: string
}

/** One discovered skill file across the writable roots. */
export interface ScannedSkill {
  readonly name: string
  readonly scopeDir: SkillScopeDir
  readonly rank: number
  /** The SKILL.md (or `<name>.md`) file itself. */
  readonly file: string
  /** The skill's resource directory (`<root>/<name>` or the root for file skills). */
  readonly dir: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Why this entry could not be parsed as a skill, when it cannot. */
  readonly parseError?: string
}

/** One parsed SKILL.md for the detail editor. */
export interface SkillFile {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly body: string
  readonly file: string
}

/** The absolute path of one scope dir's root under the given homes. */
export function skillRootPath(scopeDir: SkillScopeDir, homes: SkillHomes): string {
  const project = homes.projectRoot
  switch (scopeDir) {
    case 'project-dsh': return join(project ?? '', '.dsh', 'skills')
    case 'project-agents': return join(project ?? '', '.agents', 'skills')
    case 'user-dsh': return join(homes.dshHome, 'skills')
    case 'user-agents': return join(homes.agentsHome, 'skills')
  }
}

/** All currently configured roots, in precedence order. */
export function skillRoots(homes: SkillHomes): { scopeDir: SkillScopeDir; path: string; rank: number }[] {
  const scopeDirs: SkillScopeDir[] = homes.projectRoot === undefined
    ? ['user-dsh', 'user-agents']
    : ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']
  return scopeDirs.map(scopeDir => ({ scopeDir, path: skillRootPath(scopeDir, homes), rank: SOURCE_RANK[scopeDir] }))
}

/** Scan every root with the provider's discovery rules; missing roots are empty. */
export async function scanSkills(homes: SkillHomes): Promise<ScannedSkill[]> {
  const found: ScannedSkill[] = []
  for (const root of skillRoots(homes)) {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (root.scopeDir === 'user-dsh' && entry.name === '.system') continue
      const file = entry.isDirectory() ? join(root.path, entry.name, 'SKILL.md') : entry.name.endsWith('.md') ? join(root.path, entry.name) : undefined
      if (file === undefined) continue
      const dir = entry.isDirectory() ? join(root.path, entry.name) : root.path
      const parsed = await parseSkillFile(file)
      found.push({
        name: parsed.name ?? entry.name.replace(/\.md$/, ''),
        scopeDir: root.scopeDir,
        rank: root.rank,
        file,
        dir,
        description: parsed.description ?? '',
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
        ...(parsed.parseError !== undefined ? { parseError: parsed.parseError } : {}),
      })
    }
  }
  return found
}

/** Read one SKILL.md for the editor; throws SkillStoreError on hard failures. */
export async function readSkillFile(file: string): Promise<SkillFile> {
  const parsed = await parseSkillFile(file)
  if (parsed.parseError !== undefined) throw new SkillStoreError(parsed.parseError, 'cap/yaml-invalid')
  return {
    name: parsed.name ?? '',
    description: parsed.description ?? '',
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    modelInvocable: parsed.modelInvocable,
    userInvocable: parsed.userInvocable,
    body: parsed.body,
    file,
  }
}

/** Load one SKILL.md's frontmatter as an editable document plus its body. */
async function loadSkillDocument(file: string): Promise<{ document: Document.Parsed; body: string }> {
  const raw = await readText(file)
  if (raw === undefined) throw new SkillStoreError(`skill file not found: ${file}`, 'cap/not-found')
  const split = splitFrontmatter(raw)
  if (split === undefined) throw new SkillStoreError('missing YAML frontmatter', 'cap/yaml-invalid')
  const document = parseDocument(split.frontmatter)
  if (document.errors[0] !== undefined) {
    throw new SkillStoreError(`existing frontmatter is invalid: ${document.errors[0].message}`, 'cap/yaml-invalid')
  }
  if (!isMap(document.contents)) {
    throw new SkillStoreError('existing frontmatter is invalid: not a mapping', 'cap/yaml-invalid')
  }
  return { document, body: split.body }
}

/** Create or overwrite `<root>/<name>/SKILL.md`, preserving unknown frontmatter on overwrite. */
export async function writeSkill(root: string, request: {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly body: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}): Promise<{ file: string; created: boolean }> {
  const name = request.name.trim()
  if (!SKILL_NAME.test(name)) {
    throw new SkillStoreError(`skill name must be kebab-case (a-z, 0-9, hyphen segments): ${name}`, 'cap/invalid-config')
  }
  if (request.description.trim() === '') {
    throw new SkillStoreError('skill description must not be empty', 'cap/invalid-config')
  }
  const dir = join(root, name)
  const file = join(dir, 'SKILL.md')
  let document: Document.Parsed
  let body = request.body
  let created = false
  if (await readText(file) === undefined) {
    document = parseDocument('{}')
    ;(document.contents as YAMLMap).flow = false
    created = true
  } else {
    await backup(file)
    const loaded = await loadSkillDocument(file)
    document = loaded.document
    body = request.body
  }
  const frontmatter = document.contents as YAMLMap
  setScalar(frontmatter, KEY_NAME, name)
  setScalar(frontmatter, KEY_DESCRIPTION, request.description.trim())
  setOptionalScalar(frontmatter, KEY_WHEN, request.whenToUse?.trim())
  // Toggles always serialize canonically (true/false), normalizing any loose
  // upstream-accepted spellings the file previously carried.
  setScalar(frontmatter, KEY_DISABLE_MODEL, !request.modelInvocable)
  setScalar(frontmatter, KEY_USER_INVOCABLE, request.userInvocable)

  await mkdir(dir, { recursive: true })
  await writeFileAtomic(file, serialize(document, body), { mode: 0o600 })
  return { file, created }
}

/** Flip the two invocation flags of one SKILL.md without touching anything else. */
export async function setSkillFlags(file: string, changes: {
  readonly modelInvocable?: boolean
  readonly userInvocable?: boolean
}): Promise<void> {
  const { document, body } = await loadSkillDocument(file)
  await backup(file)
  const frontmatter = document.contents as YAMLMap
  if (changes.modelInvocable !== undefined) setScalar(frontmatter, KEY_DISABLE_MODEL, !changes.modelInvocable)
  if (changes.userInvocable !== undefined) setScalar(frontmatter, KEY_USER_INVOCABLE, changes.userInvocable)
  await writeFileAtomic(file, serialize(document, body), { mode: 0o600 })
}

/**
 * Move one skill (directory or file) into the trash root. Each trash item is
 * a directory `<ts>-<name>/` holding the moved source plus a `trash-meta.json`
 * recording where it came from — that metadata is what restore acts on.
 * Returns the trash directory path.
 */
export async function removeSkillToTrash(file: string, trashBase: string): Promise<string> {
  const parsed = await parseSkillFile(file)
  const skillDir = dirname(file)
  const isDirectorySkill = basename(file) === 'SKILL.md'
  const source = isDirectorySkill ? skillDir : file
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = parsed.name ?? basename(source).replace(/\.md$/, '')
  await mkdir(trashBase, { recursive: true })
  const target = join(trashBase, `${stamp}-${name}`)
  await rm(target, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(target, { recursive: true })
  await rename(source, join(target, basename(source)))
  await writeFileAtomic(join(target, 'trash-meta.json'), JSON.stringify({
    kind: isDirectorySkill ? 'skill-dir' : 'skill-file',
    name,
    originalPath: source,
    trashedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 })
  return target
}

/** One trash item as shown by the panel. */
export type TrashItem = {
  readonly id: string
  readonly name: string
  readonly kind: 'skill-dir' | 'skill-file' | 'unknown'
  readonly path: string
  readonly originalPath?: string
  readonly trashedAt?: string
}

interface TrashMeta {
  readonly kind?: 'skill-dir' | 'skill-file'
  readonly name?: string
  readonly originalPath?: string
  readonly trashedAt?: string
}

/** Every trash item, newest first; pre-metadata items list without restore. */
export async function listTrashItems(trashBase: string): Promise<TrashItem[]> {
  let entries
  try {
    entries = await readdir(trashBase, { withFileTypes: true })
  } catch {
    return []
  }
  const items: TrashItem[] = []
  for (const entry of entries) {
    const path = join(trashBase, entry.name)
    if (entry.isDirectory()) {
      const meta = await readTrashMeta(path)
      items.push({
        id: entry.name,
        name: meta?.name ?? legacyTrashName(entry.name),
        kind: meta?.kind ?? (await exists(join(path, 'SKILL.md')) ? 'skill-dir' : 'unknown'),
        path,
        ...(meta?.originalPath !== undefined ? { originalPath: meta.originalPath } : {}),
        ...(meta?.trashedAt !== undefined ? { trashedAt: meta.trashedAt } : {}),
      })
    } else {
      // Pre-metadata file skills were moved whole; the extension is lost.
      items.push({ id: entry.name, name: legacyTrashName(entry.name), kind: 'skill-file', path })
    }
  }
  return items.sort((left, right) => right.id.localeCompare(left.id))
}

/** Restore one item to its original path; conflicts and legacy items fail loudly. */
export async function restoreTrashItem(trashBase: string, id: string): Promise<string> {
  const path = join(trashBase, id)
  const meta = await readTrashMeta(path)
  if (meta?.originalPath === undefined) {
    throw new SkillStoreError(
      'this trash item predates restore metadata; move it back by hand from ' + path,
      'cap/invalid-config',
    )
  }
  if (await exists(meta.originalPath)) {
    throw new SkillStoreError(`target already exists: ${meta.originalPath}`, 'cap/name-conflict')
  }
  await mkdir(dirname(meta.originalPath), { recursive: true })
  await rename(join(path, basename(meta.originalPath)), meta.originalPath)
  await rm(path, { recursive: true, force: true })
  return meta.originalPath
}

/** Destroy one trash item permanently. */
export async function deleteTrashItem(trashBase: string, id: string): Promise<void> {
  const path = join(trashBase, id)
  if (basename(path) !== id || id === '' || id === '.' || id === '..') {
    throw new SkillStoreError(`invalid trash id: ${id}`, 'cap/invalid-config')
  }
  await rm(path, { recursive: true, force: true })
}

/** Destroy every trash item permanently; returns how many were removed. */
export async function clearTrashItems(trashBase: string): Promise<number> {
  let removed = 0
  for (const item of await listTrashItems(trashBase)) {
    await deleteTrashItem(trashBase, item.id)
    removed += 1
  }
  return removed
}

async function readTrashMeta(path: string): Promise<TrashMeta | undefined> {
  try {
    const raw = await readFile(join(path, 'trash-meta.json'), 'utf8')
    const parsed = JSON.parse(raw) as TrashMeta
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Strip the `<ISO stamp>-` prefix of a trash entry name. */
function legacyTrashName(id: string): string {
  return id.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '')
}

// ---- Import / export bundles ----

/** One incoming file of a skill archive (path relative, POSIX separators). */
export interface IncomingFile {
  readonly path: string
  readonly base64: string
}

export interface SkillImportOutcome {
  readonly imported: readonly { readonly name: string; readonly file: string }[]
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

const IMPORT_FILE_LIMIT = 200
const IMPORT_FILE_SIZE = 2 * 1024 * 1024
const IMPORT_TOTAL_SIZE = 10 * 1024 * 1024
const BUNDLE_FILE_LIMIT = 200
const BUNDLE_SIZE_LIMIT = 10 * 1024 * 1024
const JUNK_SEGMENTS = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db'])

/**
 * Import skills from an extracted archive or folder listing. Groups by the
 * top path segment: `<dir>/SKILL.md` (+ sibling assets) becomes a directory
 * skill named by its frontmatter, a bare `<name>.md` becomes a file skill.
 * Files are written verbatim — the author's frontmatter survives untouched.
 */
export async function importSkillFiles(
  root: string,
  files: readonly IncomingFile[],
  overwrite: boolean,
): Promise<SkillImportOutcome> {
  if (files.length === 0) throw new SkillStoreError('the import contains no files', 'cap/invalid-config')
  if (files.length > IMPORT_FILE_LIMIT) {
    throw new SkillStoreError(`the import exceeds ${IMPORT_FILE_LIMIT} files`, 'cap/invalid-config')
  }
  const decoded: { path: string; bytes: Buffer }[] = []
  let total = 0
  for (const file of files) {
    const bytes = Buffer.from(file.base64, 'base64')
    if (bytes.length === 0) continue
    if (bytes.length > IMPORT_FILE_SIZE) {
      throw new SkillStoreError(`${file.path} exceeds the ${IMPORT_FILE_SIZE} byte per-file limit`, 'cap/invalid-config')
    }
    total += bytes.length
    if (total > IMPORT_TOTAL_SIZE) {
      throw new SkillStoreError(`the import exceeds the ${IMPORT_TOTAL_SIZE} byte total limit`, 'cap/invalid-config')
    }
    const path = normalizeImportPath(file.path)
    if (hasJunkSegment(path)) continue
    decoded.push({ path, bytes })
  }
  if (decoded.length === 0) throw new SkillStoreError('the import contains no usable files', 'cap/invalid-config')

  // Skill roots are the directories holding a SKILL.md (zips often add one
  // wrapper level); every file joins its deepest owning root. Root-level
  // `.md` files are file skills; anything else is an orphan.
  const roots = decoded
    .filter(file => file.path.endsWith('/SKILL.md'))
    .map(file => file.path.slice(0, -'/SKILL.md'.length))
    .filter(dir => dir !== '')
  const groups = new Map<string, { path: string; bytes: Buffer }[]>()
  const orphans = new Set<string>()
  for (const file of decoded) {
    const owner = roots
      .filter(dir => file.path === dir || file.path.startsWith(`${dir}/`))
      .sort((left, right) => segmentCount(right) - segmentCount(left))[0]
    const key = owner ?? (file.path.includes('/') ? undefined : file.path)
    if (key === undefined) {
      orphans.add(file.path.split('/')[0])
      continue
    }
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }

  const imported: { name: string; file: string }[] = []
  const skipped: { path: string; reason: string }[] = [...orphans].map(top => ({
    path: top,
    reason: 'missing SKILL.md (expected <name>/SKILL.md)',
  }))
  for (const [key, group] of groups) {
    const outcome = await importGroup(root, key, group, overwrite)
    if (outcome.kind === 'imported') imported.push({ name: outcome.name, file: outcome.file })
    else skipped.push({ path: key.split('/')[0], reason: outcome.reason })
  }
  imported.sort((left, right) => left.name.localeCompare(right.name))
  skipped.sort((left, right) => left.path.localeCompare(right.path))
  return { imported, skipped }
}

/** Import one skill group; every failure is a skip, never a throw. */
async function importGroup(
  root: string,
  key: string,
  files: readonly { path: string; bytes: Buffer }[],
  overwrite: boolean,
): Promise<{ kind: 'imported'; name: string; file: string } | { kind: 'skipped'; reason: string }> {
  const skillFile = files.find(file => file.path === `${key}/SKILL.md`) ?? files.find(file => file.path === key)
  if (skillFile === undefined) return { kind: 'skipped', reason: 'missing SKILL.md (expected <name>/SKILL.md)' }
  const directory = skillFile.path !== key
  if (!directory && !key.endsWith('.md')) return { kind: 'skipped', reason: 'unexpected file at the archive root' }
  const parsed = parseSkillText(skillFile.bytes.toString('utf8'))
  if (parsed.name === undefined || parsed.parseError !== undefined) {
    return { kind: 'skipped', reason: parsed.parseError ?? 'invalid SKILL.md' }
  }
  const name = parsed.name
  const target = directory ? join(root, name) : join(root, `${name}.md`)
  if (await exists(target)) {
    if (!overwrite) return { kind: 'skipped', reason: `a skill named "${name}" already exists` }
    await rm(target, { recursive: true, force: true })
  }
  for (const file of files) {
    const destination = directory ? join(root, name, file.path.slice(key.length + 1)) : target
    await mkdir(dirname(destination), { recursive: true })
    await writeFileAtomic(destination, file.bytes, { mode: 0o600 })
  }
  return { kind: 'imported', name, file: directory ? join(root, name, 'SKILL.md') : target }
}

function segmentCount(path: string): number {
  return path.split('/').length
}

/** Normalize one incoming path; throws on anything that could escape the root. */
function normalizeImportPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new SkillStoreError(`invalid import path: ${path}`, 'cap/invalid-config')
  }
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw new SkillStoreError(`invalid import path: ${path}`, 'cap/invalid-config')
    }
  }
  return normalized
}

/** Archive junk (macOS resource forks, desktop thumbnails) drops out silently. */
function hasJunkSegment(path: string): boolean {
  return path.split('/').some(segment => JUNK_SEGMENTS.has(segment))
}

/** Read one skill (directory walk or single file) as base64 payloads for export. */
export async function readSkillBundle(file: string): Promise<{ name: string; files: { path: string; base64: string }[] }> {
  const parsed = await parseSkillFile(file)
  const name = parsed.name ?? basename(file).replace(/\.md$/, '')
  if (basename(file) !== 'SKILL.md') {
    return { name, files: [{ path: `${name}.md`, base64: (await readFile(file)).toString('base64') }] }
  }
  const dir = dirname(file)
  const files: { path: string; base64: string }[] = []
  let total = 0
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (files.length >= BUNDLE_FILE_LIMIT || depth > 6) return
    const entries = await readdir(join(dir, relative), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.cap-bak-') || JUNK_SEGMENTS.has(entry.name)) continue
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(child, depth + 1)
        continue
      }
      const bytes = await readFile(join(dir, child))
      total += bytes.length
      if (total > BUNDLE_SIZE_LIMIT) {
        throw new SkillStoreError(`the skill directory exceeds the ${BUNDLE_SIZE_LIMIT} byte export limit`, 'cap/invalid-config')
      }
      files.push({ path: child, base64: bytes.toString('base64') })
      if (files.length >= BUNDLE_FILE_LIMIT) return
    }
  }
  await walk('', 0)
  files.sort((left, right) =>
    left.path === 'SKILL.md' ? -1 : right.path === 'SKILL.md' ? 1 : left.path.localeCompare(right.path))
  return { name, files }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ---- internals ----

interface ParsedFile {
  readonly name?: string
  readonly description?: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly body: string
  readonly parseError?: string
}

async function parseSkillFile(file: string): Promise<ParsedFile> {
  const raw = await readText(file)
  if (raw === undefined) {
    return { ...EMPTY_PARSE, parseError: `skill file not found: ${file}` }
  }
  return parseSkillText(raw)
}

const EMPTY_PARSE: ParsedFile = { modelInvocable: true, userInvocable: true, body: '', parseError: undefined }

/** Parse one SKILL.md's text with the provider's grammar (import validation). */
export function parseSkillText(raw: string): ParsedFile {
  const split = splitFrontmatter(raw)
  if (split === undefined) {
    return { ...EMPTY_PARSE, parseError: 'missing YAML frontmatter' }
  }
  const document = parseDocument(split.frontmatter)
  if (document.errors[0] !== undefined) {
    return { ...EMPTY_PARSE, parseError: `invalid frontmatter YAML: ${document.errors[0].message}` }
  }
  if (!isMap(document.contents)) {
    return { ...EMPTY_PARSE, parseError: 'frontmatter must be a mapping' }
  }
  const data = document.contents
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (data.has(legacy)) {
      return { ...EMPTY_PARSE, parseError: `frontmatter field "${legacy}" is unsupported; use the canonical keys` }
    }
  }
  const name = textField(data, KEY_NAME)
  const description = textField(data, KEY_DESCRIPTION)
  if (name === undefined || description === undefined) {
    return { ...EMPTY_PARSE, parseError: 'frontmatter requires name and description' }
  }
  if (!SKILL_NAME.test(name)) {
    return { ...EMPTY_PARSE, parseError: `invalid skill name "${name}" (must be kebab-case)` }
  }
  let modelInvocable = true
  let userInvocable = true
  try {
    const disableModel = frontmatterBoolean(data, KEY_DISABLE_MODEL)
    const userFlag = frontmatterBoolean(data, KEY_USER_INVOCABLE)
    modelInvocable = disableModel !== true
    userInvocable = userFlag !== false
  } catch (error) {
    return { ...EMPTY_PARSE, parseError: error instanceof Error ? error.message : String(error) }
  }
  const whenToUse = textField(data, KEY_WHEN)
  return {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    modelInvocable,
    userInvocable,
    body: split.body,
  }
}

/** Split a leading `---` frontmatter block; returns undefined when absent.
 * Line endings normalize to LF: the `yaml` parser rejects a CR that trails a
 * closing quote on CRLF files that the provider's js-yaml dialect accepts. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } | undefined {
  if (!raw.startsWith('---')) return undefined
  const firstNewline = raw.indexOf('\n')
  if (firstNewline < 0) return undefined
  let cursor = firstNewline + 1
  while (cursor <= raw.length) {
    const next = raw.indexOf('\n', cursor)
    const lineEnd = next < 0 ? raw.length : next
    if (raw.slice(cursor, lineEnd).replace(/\r$/, '') === '---') {
      return {
        frontmatter: raw.slice(firstNewline + 1, cursor - 1).replace(/\r/g, ''),
        body: raw.slice(lineEnd + 1).replace(/\r\n/g, '\n'),
      }
    }
    if (next < 0) return undefined
    cursor = next + 1
  }
  return undefined
}

/** Serialize the frontmatter document back onto its markdown body. */
function serialize(document: Document.Parsed, body: string): string {
  const text = String(document)
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '')
  return trimmedBody === '' ? `---\n${text}---\n` : `---\n${text}---\n\n${trimmedBody}\n`
}

function setScalar(map: YAMLMap, key: string, value: string | boolean): void {
  map.set(key, value)
}

function setOptionalScalar(map: YAMLMap, key: string, value: string | undefined): void {
  if (value === undefined || value === '') map.delete(key)
  else map.set(key, value)
}

function textField(map: { get(key: string): unknown }, key: string): string | undefined {
  const value = map.get(key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Upstream boolean grammar: true/false, 1/0, yes/no, on/off (case-insensitive). */
function frontmatterBoolean(map: { has(key: string): boolean; get(key: string): unknown }, key: string): boolean | undefined {
  if (!map.has(key)) return undefined
  const value = map.get(key)
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Keep the newest `.cap-bak-*` copies beside the target; never blocks a write. */
async function backup(file: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(file, `${file}.cap-bak-${stamp}`)
    const base = basename(file)
    const backups = (await readdir(dirname(file)))
      .filter(name => name.startsWith(`${base}.cap-bak-`))
      .sort()
    for (const name of backups.slice(0, Math.max(0, backups.length - 5))) {
      await rm(join(dirname(file), name)).catch(() => undefined)
    }
  } catch {
    // A failed history copy never blocks the write; the atomic write still lands.
  }
}

/** Whether one path lies inside a root (both sides resolved, separator-aware). */
export function isUnderRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`)
}

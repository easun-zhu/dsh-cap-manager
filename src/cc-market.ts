/**
 * The built-in Claude Code plugin source (M6): Anthropic's official
 * `claude-plugins-official` marketplace. Fetches and caches the marketplace
 * index, downloads plugin payloads as GitHub tarballs, and unpacks them with
 * the same path-safety discipline as the skill archive import. The fetcher is
 * injectable so tests run without a network.
 */

import { gunzipSync } from 'fflate'
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Marketplace identity: the only built-in source (DESIGN.md §7.6). */
export const MARKET_NAME = 'claude-plugins-official'
const MARKET_OWNER = 'anthropics'
const MARKET_REF = 'main'
const MARKET_INDEX_URL = `https://raw.githubusercontent.com/${MARKET_OWNER}/${MARKET_NAME}/${MARKET_REF}/.claude-plugin/marketplace.json`
const MARKET_TARBALL_URL = `https://codeload.github.com/${MARKET_OWNER}/${MARKET_NAME}/tar.gz/refs/heads/${MARKET_REF}`
/** Marketplace HEAD commit; the precise pin for in-repo (path) plugins. */
const MARKET_HEAD_URL = `https://api.github.com/repos/${MARKET_OWNER}/${MARKET_NAME}/commits/${MARKET_REF}`

const CACHE_TTL_MS = 10 * 60 * 1000
export const TARBALL_BYTE_LIMIT = 64 * 1024 * 1024
const FILE_BYTE_LIMIT = 8 * 1024 * 1024
const FILE_COUNT_LIMIT = 1500
const JUNK_SEGMENTS = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db'])

export type Fetcher = (url: string) => Promise<Uint8Array>

/** Pinned git source of one marketplace entry. */
export interface GitSource {
  readonly source: 'git-subdir' | 'url'
  readonly url: string
  readonly path?: string
  readonly ref?: string
  readonly sha?: string
}

/** One marketplace.json entry (subset we consume). */
export interface MarketEntry {
  readonly name: string
  readonly description?: string
  readonly author?: { readonly name?: string; readonly email?: string }
  readonly category?: string
  readonly homepage?: string
  readonly version?: string
  /** "./plugins/x" (inside the marketplace repo) or a pinned git source. */
  readonly source: string | GitSource
}

/** Cached index plus its provenance pin (ETag when the server gave one). */
export interface MarketCache {
  readonly fetchedAt: number
  readonly pin: string
  readonly entries: readonly MarketEntry[]
}

/**
 * Whether a pin identifies one exact commit (a raw entry sha, or the
 * marketplace HEAD sha of the moment). Pins of different exactness never
 * compare as updates — a sha pin next to a timestamp fallback pin means
 * "unknown", not "changed".
 */
export function isExactPin(pin: string): boolean {
  return pin.length === 40 || /^market@[0-9a-f]{40}$/.test(pin)
}

/** Throws `cap/cc-network` with a readable cause; every call is time-bounded. */
export const httpFetcher: Fetcher = async url => {
  // Tarball downloads get a generous ceiling; index/HEAD calls must settle fast.
  const timeoutMs = url.includes('codeload.github.com') ? 120_000 : 20_000
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new RemoteError('cap/cc-network', `fetching ${url} failed within ${String(Math.floor(timeoutMs / 1000))}s: ${detail}`, {})
  }
  if (!response.ok) {
    throw new RemoteError('cap/cc-network', `fetching ${url} failed: HTTP ${String(response.status)}`, {})
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > TARBALL_BYTE_LIMIT) {
    throw new RemoteError('cap/cc-network', `${url} exceeds the ${String(TARBALL_BYTE_LIMIT)} byte download limit`, {})
  }
  return bytes
}

export class CcMarket {
  private cache: MarketCache | undefined
  private readonly cachePath: string
  private readonly fetcher: Fetcher

  constructor(cachePath: string, fetcher: Fetcher) {
    this.cachePath = cachePath
    this.fetcher = fetcher
  }

  /** List marketplace entries; the on-disk cache serves for CACHE_TTL_MS. */
  async list(force = false): Promise<MarketCache> {
    if (!force && this.cache !== undefined) return this.cache
    const cached = await this.readCache()
    if (!force && cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.cache = cached
      return cached
    }
    try {
      const bytes = await this.fetcher(MARKET_INDEX_URL)
      // The HEAD commit sha pins in-repo (path) plugins precisely; when the
      // API is unreachable or rate-limited, the timestamp fallback keeps the
      // panel alive and update stays conservative (no spurious badge).
      const head = await this.fetchHead()
      const pin = head !== undefined ? `market@${head}` : `market@${new Date().toISOString()}`
      const entries = parseMarketIndex(bytes)
      const cache: MarketCache = { fetchedAt: Date.now(), pin, entries }
      this.cache = cache
      await mkdir(dirname(this.cachePath), { recursive: true }).catch(() => undefined)
      await fsWriteFile(this.cachePath, JSON.stringify(cache, null, 2), 'utf8').catch(() => undefined)
      return cache
    } catch (error) {
      // GitHub unreachable: a stale index still browses, and sha-pinned
      // installs keep working — serve the cache instead of failing the panel.
      if (cached !== undefined) {
        this.cache = cached
        return cached
      }
      throw error
    }
  }

  /** Best-effort marketplace HEAD commit sha (40 hex digits). */
  private async fetchHead(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await this.fetcher(MARKET_HEAD_URL))) as { sha?: unknown }
      return typeof parsed.sha === 'string' && /^[0-9a-f]{40}$/.test(parsed.sha) ? parsed.sha : undefined
    } catch {
      return undefined
    }
  }

  private async readCache(): Promise<MarketCache | undefined> {
    try {
      const parsed = JSON.parse(await fsReadFile(this.cachePath, 'utf8')) as MarketCache
      if (Array.isArray(parsed?.entries) && typeof parsed?.fetchedAt === 'number' && typeof parsed?.pin === 'string') return parsed
    } catch {
      /* absent or corrupt cache: refetch */
    }
    return undefined
  }

  /**
   * Download one plugin's files. Returns normalized `dir/file` paths relative
   * to the plugin root, plus the version pin for update detection.
   */
  async fetchPluginFiles(entry: MarketEntry, marketPin: string): Promise<{ files: ReadonlyMap<string, Buffer>; pin: string }> {
    const source = entry.source
    if (typeof source === 'string') {
      const files = await fetchTarballSubtree(this.fetcher, MARKET_TARBALL_URL, stripDotSlash(source))
      return { files, pin: marketPin }
    }
    const repo = githubRepo(source.url)
    const ref = source.sha ?? source.ref ?? 'HEAD'
    const files = await fetchTarballSubtree(this.fetcher, `https://codeload.github.com/${repo.owner}/${repo.name}/tar.gz/${ref}`, source.path ?? '')
    return { files, pin: source.sha ?? `ref@${ref}` }
  }
}

/** Parse and validate the marketplace index bytes. */
export function parseMarketIndex(bytes: Uint8Array): readonly MarketEntry[] {  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (cause) {
    throw new RemoteError('cap/cc-network', `marketplace.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {})
  }
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) throw new RemoteError('cap/cc-network', 'marketplace.json has no plugins array', {})
  const entries: MarketEntry[] = []
  for (const item of plugins) {
    const candidate = item as MarketEntry
    if (typeof candidate?.name !== 'string' || candidate.name === '') continue
    if (typeof candidate.source !== 'string' && !isValidGitSource(candidate.source)) continue
    entries.push({
      name: candidate.name,
      ...(candidate.description !== undefined ? { description: candidate.description } : {}),
      ...(candidate.author !== undefined ? { author: candidate.author } : {}),
      ...(candidate.category !== undefined ? { category: candidate.category } : {}),
      ...(candidate.homepage !== undefined ? { homepage: candidate.homepage } : {}),
      ...(candidate.version !== undefined ? { version: candidate.version } : {}),
      source: candidate.source,
    })
  }
  return entries
}

function isValidGitSource(source: unknown): source is GitSource {
  if (typeof source !== 'object' || source === null) return false
  const view = source as { source?: unknown; url?: unknown }
  return (view.source === 'git-subdir' || view.source === 'url') && typeof view.url === 'string'
}

/** Download a tarball and keep only the subtree under `subdir` ("" = whole archive). */
async function fetchTarballSubtree(fetcher: Fetcher, url: string, subdir: string): Promise<ReadonlyMap<string, Buffer>> {
  const tar = gunzipSync(await fetcher(url))
  const all = extractTar(tar)
  const files = new Map<string, Buffer>()
  if (subdir === '') {
    const root = commonRoot(all)
    for (const [path, bytes] of all) {
      const relative = root === '' ? path : stripLeadingRoot(path, root)
      if (relative !== '') files.set(relative, bytes)
    }
  } else {
    const root = commonRoot(all)
    const prefix = root === '' ? `${subdir}/` : `${root}/${subdir}/`
    for (const [path, bytes] of all) {
      if (!path.startsWith(prefix)) continue
      files.set(path.slice(prefix.length), bytes)
    }
  }
  if (files.size === 0) {
    throw new RemoteError('cap/cc-invalid-source', `the downloaded archive has no files under "${subdir}"`, {})
  }
  return files
}

/** GitHub tarballs nest everything under "<repo>-<ref>/"; "" when paths disagree. */
function commonRoot(files: ReadonlyMap<string, Buffer>): string {
  let root: string | undefined
  for (const path of files.keys()) {
    const top = path.split('/')[0] ?? ''
    if (root === undefined) root = top
    else if (root !== top) return ''
  }
  return root ?? ''
}

function stripLeadingRoot(path: string, root: string): string {
  return path === root || path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function stripDotSlash(source: string): string {
  return source.replace(/^\.\//, '')
}

function githubRepo(url: string): { owner: string; name: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RemoteError('cap/cc-invalid-source', `not a repository URL: ${url}`, {})
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
    throw new RemoteError('cap/cc-invalid-source', `only github.com plugin sources are supported, got ${url}`, {})
  }
  const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(segment => segment !== '')
  if (segments.length < 2) throw new RemoteError('cap/cc-invalid-source', `not a repository URL: ${url}`, {})
  return { owner: segments[0], name: segments[1] }
}

/**
 * Minimal, strict tar reader: ustar files, GNU long names ('L'), and pax
 * per-entry path overrides ('x'). Directories, links, and other special
 * members are skipped; every retained path is normalized and rejected on any
 * escape attempt (same rules as the skill import).
 */
export function extractTar(tar: Uint8Array): ReadonlyMap<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  let longName: string | undefined
  const prefix = 'cap/cc-invalid-source'
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new RemoteError(prefix, 'truncated tar archive', {})
    const data = tar.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (typeflag === 'L') {
      longName = readString(data).replace(/\0$/, '')
      continue
    }
    if (typeflag === 'x' || typeflag === 'X') {
      const paxPath = readPaxPath(data)
      if (paxPath !== undefined) longName = paxPath
      continue
    }
    if (typeflag === 'g') continue
    if (typeflag === '5' || typeflag === '1' || typeflag === '2' || (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7')) {
      longName = undefined
      continue
    }
    const name = longName ?? headerName(header)
    longName = undefined
    const normalized = normalizeTarPath(name)
    if (normalized === undefined) continue
    if (data.byteLength > FILE_BYTE_LIMIT) {
      throw new RemoteError(prefix, `archive member "${name}" exceeds the ${String(FILE_BYTE_LIMIT)} byte file limit`, {})
    }
    if (files.size >= FILE_COUNT_LIMIT) {
      throw new RemoteError(prefix, `archive exceeds the ${String(FILE_COUNT_LIMIT)} file limit`, {})
    }
    files.set(normalized, Buffer.from(data))
  }
  return files
}

function headerName(header: Uint8Array): string {
  const name = readString(header.subarray(0, 100))
  const magic = readString(header.subarray(257, 263))
  const prefixField = readString(header.subarray(345, 500))
  if (magic.startsWith('ustar') && prefixField !== '') return `${prefixField}/${name}`
  return name
}

function readOctal(header: Uint8Array, start: number, length: number): number {
  const text = readString(header.subarray(start, start + length)).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (Number.isNaN(value)) throw new RemoteError('cap/cc-invalid-source', `invalid tar size field "${text}"`, {})
  return value
}

function readString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder('latin1').decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function readPaxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data)
  for (const record of text.split('\n')) {
    const match = /^(\d+) (path)=(.*)$/.exec(record)
    if (match !== null && match[2] === 'path') return match[3]
  }
  return undefined
}

/** Normalize one archive path; undefined drops it (junk), throws on escapes. */
function normalizeTarPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (normalized === '') return undefined
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new RemoteError('cap/cc-invalid-source', `invalid archive path: ${path}`, {})
  }
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    // `.`-prefixed names are legal here (`.claude-plugin/` holds the manifest);
    // only the exact traversal markers reject the archive.
    if (segment === '..') {
      throw new RemoteError('cap/cc-invalid-source', `invalid archive path: ${path}`, {})
    }
    if (JUNK_SEGMENTS.has(segment)) return undefined
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

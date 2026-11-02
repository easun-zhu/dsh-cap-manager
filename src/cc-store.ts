/**
 * Installed Claude Code plugins (M6): the local store under
 * `$DSH_HOME/cap-manager/plugins/` — an atomic registry.json plus one
 * directory per plugin version. Content takes effect through two native
 * mechanisms: a `ctx.skills` provider serving each enabled plugin's skills/
 * (rank 550, so the user's own same-name skills win), and McpClient fibers
 * mounted per manifest `mcpServers` (ProjectMounter's diff discipline,
 * including the cross-layer serverName precheck).
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { convertMcpImport } from './import-mcp.ts'
import { parseSkillText } from './skills-store.ts'
import { collectToolCounts, fiberFacts, resolveStatus, type FiberLike } from './status-tracker.ts'
import type { MarketEntry } from './cc-market.ts'
import type { McpConfigView, McpStatus } from './types.ts'

/** Skill precedence: after the user roots (400/500), before bundled (600). */
const CC_SKILL_RANK = 550
const PROVIDER_NAME = 'cc-plugins'
const REGISTRY_FILENAME = 'registry.json'

export interface InstalledPlugin {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
  readonly installedAt: string
  readonly updatedAt: string
  /** Marketplace pin at install time (`sha` or `market@…`); drives update detection. */
  readonly pin: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string
  readonly skillNames: readonly string[]
  readonly serverNames: readonly string[]
  /** Content dsh does not consume; surfaced on the card so installs are honest. */
  readonly skippedContent: readonly string[]
}

interface Registry {
  readonly format: 1
  readonly plugins: InstalledPlugin[]
}

interface Manifest {
  name?: string
  version?: string
  description?: string
  author?: { name?: string }
  homepage?: string
  mcpServers?: Record<string, unknown>
}

export interface InstallOutcome {
  readonly name: string
  readonly version: string
  readonly skills: readonly string[]
  readonly servers: readonly string[]
  readonly warnings: readonly string[]
  readonly skippedContent: readonly string[]
  /** The downloaded content was byte-identical to what is installed; only the pin moved. */
  readonly unchanged?: boolean
}

interface MountedServer {
  readonly fiber: Fiber
  readonly configKey: string
}

/** Structural view of the skill registry (`ctx.skills`). */
interface SkillsRegistryLike {
  registerProvider(create: (control: { readonly invalidate: () => void }) => SkillProviderLike): () => void
}

interface SkillProviderLike {
  readonly name: string
  list(options: unknown): Promise<unknown>
  get(candidate: unknown, options: unknown): Promise<unknown>
}

export interface CcStoreOptions {
  /** `$DSH_HOME/cap-manager/plugins`. */
  readonly baseDir: string
  /** serverNames already owned by patch layers or project mounts. */
  readonly reservedNames: () => readonly string[]
  /** Called after any registry or mount change (emits cap/changed). */
  readonly onChanged: () => void
}

export class CcPluginStore {
  private registry: Registry = { format: 1, plugins: [] }
  private readonly invalidate: (() => void) | undefined
  private readonly mounts = new Map<string, Map<string, MountedServer>>()
  private readonly mountErrors = new Map<string, string>()
  private serial = Promise.resolve()
  private readonly ctx: Context
  private readonly market: { fetchPluginFiles(entry: MarketEntry, marketPin: string): Promise<{ files: ReadonlyMap<string, Buffer>; pin: string }> }
  private readonly options: CcStoreOptions

  constructor(ctx: Context, market: CcPluginStore['market'], options: CcStoreOptions) {
    this.ctx = ctx
    this.market = market
    this.options = options
    const registry = (this.ctx.get('skills') as SkillsRegistryLike | undefined) ?? undefined
    let invalidate: (() => void) | undefined
    if (registry !== undefined) {
      const dispose = registry.registerProvider(control => {
        invalidate = () => control.invalidate()
        return new CcSkillProvider(this)
      })
      this.ctx.effect(() => dispose)
    } else {
      this.ctx.logger.warn('cap-manager: ctx.skills is unavailable; Claude Code plugin skills will not register')
    }
    this.invalidate = invalidate
    void this.load().then(() => this.refreshMounts())
  }

  installed(): readonly InstalledPlugin[] {
    return this.registry.plugins
  }

  installedByName(name: string): InstalledPlugin | undefined {
    return this.registry.plugins.find(plugin => plugin.name === name)
  }

  /** Owning plugin name for a skill this provider serves (panel attribution). */
  skillOwner(skillName: string): string | undefined {
    return this.registry.plugins.find(plugin => plugin.enabled && plugin.skillNames.includes(skillName))?.name
  }

  /** Live mount status for one plugin's servers (panel cards). */
  async serverStatuses(name: string): Promise<Record<string, { status: McpStatus; toolCount: number; error?: string }>> {
    const mounted = this.mounts.get(name)
    const view: Record<string, { status: McpStatus; toolCount: number; error?: string }> = {}
    const plugin = this.installedByName(name)
    if (plugin === undefined) return view
    const counts = collectToolCounts(this.ctx, plugin.serverNames)
    for (const serverName of plugin.serverNames) {
      const error = this.mountErrors.get(`${name}/${serverName}`)
      const entry = mounted?.get(serverName)
      if (entry === undefined || error !== undefined) {
        view[serverName] = {
          status: plugin.enabled ? (error !== undefined ? 'failed' : 'stopped') : 'disabled',
          toolCount: 0,
          ...(error !== undefined ? { error } : {}),
        }
        continue
      }
      const facts = fiberFacts(entry.fiber as unknown as FiberLike, counts.get(serverName) ?? 0)
      const status = resolveStatus(true, facts)
      view[serverName] = { status, toolCount: facts.toolCount, ...(facts.fiberError !== undefined ? { error: facts.fiberError } : {}) }
    }
    return view
  }

  /** Download, store, and activate one marketplace entry. */
  async install(entry: MarketEntry, marketPin: string, reinstall = false): Promise<InstallOutcome> {
    return this.enqueue(async () => {
      const existing = this.installedByName(entry.name)
      if (existing !== undefined && !reinstall) {
        throw new RemoteError('cap/name-conflict', `plugin "${entry.name}" is already installed`, {})
      }
      const { files, pin } = await this.market.fetchPluginFiles(entry, marketPin)
      // Update precision: byte-identical content only adopts the new pin;
      // nothing is reinstalled, no skill or mount is touched.
      if (existing !== undefined) {
        const installedKey = await directoryContentKey(join(this.options.baseDir, 'store', existing.name, existing.version))
        if (installedKey !== undefined && installedKey === filesContentKey(files)) {
          const adopted: InstalledPlugin = { ...existing, pin, updatedAt: new Date().toISOString() }
          await this.saveRegistry(adopted, existing)
          return {
            name: adopted.name,
            version: adopted.version,
            skills: adopted.skillNames,
            servers: adopted.serverNames,
            warnings: [],
            skippedContent: adopted.skippedContent,
            unchanged: true,
          }
        }
      }
      const manifest = readManifest(files)
      if (manifest === undefined) {
        throw new RemoteError('cap/cc-invalid-source', `plugin "${entry.name}" has no .claude-plugin/plugin.json`, {})
      }
      const name = manifest.name ?? entry.name
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
        throw new RemoteError('cap/cc-invalid-source', `invalid plugin name "${name}"`, {})
      }
      const version = manifest.version ?? entry.version ?? '0.0.0'
      const { skills, skippedContent } = await this.materialize(name, version, files)
      const warnings: string[] = []
      const serverNames: string[] = []
      const serverConfigs = convertServers(manifest, warnings)
      for (const config of serverConfigs) {
        if (this.isReserved(config.serverName, name)) {
          warnings.push(`serverName ${config.serverName} conflicts with an existing MCP row; not mounted`)
          continue
        }
        serverNames.push(config.serverName)
      }
      const description = manifest.description ?? entry.description
      const author = manifest.author?.name ?? entry.author?.name
      const homepage = manifest.homepage ?? entry.homepage
      const plugin: InstalledPlugin = {
        name,
        version,
        // A reinstall (update) keeps the user's enabled choice.
        enabled: existing?.enabled ?? true,
        installedAt: existing?.installedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pin,
        ...(description !== undefined ? { description } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(homepage !== undefined ? { homepage } : {}),
        skillNames: skills,
        serverNames,
        skippedContent,
      }
      await this.saveRegistry(plugin, existing)
      await this.refreshMounts()
      this.invalidate?.()
      this.options.onChanged()
      return {
        name, version, skills, servers: serverNames, warnings, skippedContent,
      }
    })
  }

  async uninstall(name: string): Promise<void> {
    await this.enqueue(async () => {
      const existing = this.installedByName(name)
      if (existing === undefined) throw new RemoteError('cap/not-found', `plugin "${name}" is not installed`, {})
      this.registry = { format: 1, plugins: this.registry.plugins.filter(plugin => plugin.name !== name) }
      await this.persist()
      await this.refreshMounts()
      await rm(join(this.options.baseDir, 'store', existing.name), { recursive: true, force: true }).catch(() => undefined)
      this.invalidate?.()
      this.options.onChanged()
    })
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      const existing = this.installedByName(name)
      if (existing === undefined) throw new RemoteError('cap/not-found', `plugin "${name}" is not installed`, {})
      this.registry = {
        format: 1,
        plugins: this.registry.plugins.map(plugin => plugin.name === name ? { ...plugin, enabled, updatedAt: new Date().toISOString() } : plugin),
      }
      await this.persist()
      await this.refreshMounts()
      this.invalidate?.()
      this.options.onChanged()
    })
  }

  /** Skills of every enabled plugin, for the provider's list(). */
  async listProviderSkills(): Promise<readonly ProviderSkill[]> {
    const found: ProviderSkill[] = []
    for (const plugin of this.registry.plugins.filter(item => item.enabled)) {
      const skillsDir = join(this.options.baseDir, 'store', plugin.name, plugin.version, 'skills')
      for (const candidate of await skillCandidatesOf(skillsDir).catch(() => [] as SkillCandidateFile[])) {
        const parsed = parseSkillText(candidate.file)
        if (parsed.parseError !== undefined || parsed.name === undefined) continue
        found.push({
          plugin: plugin.name,
          name: parsed.name,
          description: parsed.description ?? '',
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          modelInvocable: parsed.modelInvocable,
          userInvocable: parsed.userInvocable,
          file: candidate.path,
          directory: candidate.directory,
        })
      }
    }
    return found
  }

  async close(): Promise<void> {
    for (const mounted of this.mounts.values()) {
      await Promise.allSettled([...mounted.values()].map(entry => entry.fiber.dispose()))
      mounted.clear()
    }
    this.mounts.clear()
    this.mountErrors.clear()
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(join(this.options.baseDir, REGISTRY_FILENAME), 'utf8')) as Registry
      if (parsed?.format === 1 && Array.isArray(parsed.plugins)) this.registry = parsed
    } catch {
      /* absent registry starts empty */
    }
  }

  /** Serialize store mutations; the resolved registry matches the disk. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.then(() => undefined, () => undefined)
    return next
  }

  private async persist(): Promise<void> {
    const file = join(this.options.baseDir, REGISTRY_FILENAME)
    await backup(file)
    await writeFileAtomic(file, `${JSON.stringify(this.registry, null, 2)}\n`, { mode: 0o600 })
  }

  private async saveRegistry(plugin: InstalledPlugin, previous: InstalledPlugin | undefined): Promise<void> {
    const others = this.registry.plugins.filter(item => item.name !== plugin.name)
    this.registry = { format: 1, plugins: [...others, plugin].sort((left, right) => left.name.localeCompare(right.name)) }
    await this.persist()
    if (previous === undefined) return
    if (previous.name !== plugin.name) {
      // The manifest renamed the plugin: the whole old-name directory goes.
      await rm(join(this.options.baseDir, 'store', previous.name), { recursive: true, force: true }).catch(() => undefined)
    } else if (previous.version !== plugin.version) {
      await rm(join(this.options.baseDir, 'store', previous.name, previous.version), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Write one version's files into the store (temp dir, then rename into place). */
  private async materialize(name: string, version: string, files: ReadonlyMap<string, Buffer>): Promise<{ skills: string[]; skippedContent: string[] }> {
    const root = join(this.options.baseDir, 'store', name)
    const target = join(root, version)
    const temp = join(root, `.staging-${Date.now()}`)
    await rm(temp, { recursive: true, force: true })
    await mkdir(temp, { recursive: true })
    try {
      for (const [path, bytes] of files) {
        const destination = join(temp, path)
        if (dirname(destination) !== temp) await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, bytes, { mode: 0o600 })
      }
      await rm(target, { recursive: true, force: true })
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const skills = (await skillCandidatesOf(join(target, 'skills'))).map(candidate => candidate.skillName)
    const skipped: string[] = []
    for (const marker of ['commands', 'agents', 'hooks']) {
      if (await exists(join(target, marker))) skipped.push(marker)
    }
    return { skills, skippedContent: skipped }
  }

  /** Diff mounts against the registry: conflicts logged, fibers disposed. */
  private async refreshMounts(): Promise<void> {
    const desired = new Map<string, Map<string, { plain: Record<string, unknown>; key: string }>>()
    for (const plugin of this.registry.plugins) {
      if (!plugin.enabled) continue
      const warnings: string[] = []
      const configs = convertServers(await readManifestOf(this.options.baseDir, plugin), warnings)
      const perPlugin = new Map<string, { plain: Record<string, unknown>; key: string }>()
      for (const config of configs) {
        if (!plugin.serverNames.includes(config.serverName)) continue
        perPlugin.set(config.serverName, { plain: config.plain, key: JSON.stringify(config.plain) })
      }
      desired.set(plugin.name, perPlugin)
    }

    for (const [pluginName, mounted] of [...this.mounts]) {
      const next = desired.get(pluginName)
      for (const [serverName, entry] of [...mounted]) {
        const config = next?.get(serverName)
        if (config === undefined || config.key !== entry.configKey) {
          mounted.delete(serverName)
          await entry.fiber.dispose().catch(() => undefined)
        }
      }
      if (next === undefined || next.size === 0) this.mounts.delete(pluginName)
    }

    this.mountErrors.clear()
    const taken = new Set(this.options.reservedNames())
    for (const mounted of this.mounts.values()) {
      for (const serverName of mounted.keys()) taken.add(serverName)
    }
    for (const [pluginName, configs] of desired) {
      let mounted = this.mounts.get(pluginName)
      if (mounted === undefined) {
        mounted = new Map()
        this.mounts.set(pluginName, mounted)
      }
      for (const [serverName, config] of configs) {
        if (mounted.has(serverName)) continue
        if (taken.has(serverName)) {
          this.mountErrors.set(`${pluginName}/${serverName}`, `serverName ${serverName} conflicts with an existing MCP row`)
          continue
        }
        taken.add(serverName)
        try {
          const parsed = McpClient.Config(config.plain as Parameters<typeof McpClient.Config>[0])
          const fiber = this.ctx.plugin(McpClient, parsed)
          mounted.set(serverName, { fiber, configKey: config.key })
        } catch (error) {
          this.mountErrors.set(`${pluginName}/${serverName}`, `invalid config: ${error instanceof Error ? error.message : String(error)}`)
          this.ctx.logger.warn(`cap-manager: mounting plugin server ${pluginName}/${serverName} failed: ${String(error)}`)
        }
      }
    }
  }

  private isReserved(serverName: string, ownPlugin: string): boolean {
    if (this.options.reservedNames().includes(serverName)) return true
    for (const [pluginName, mounted] of this.mounts) {
      if (pluginName === ownPlugin) continue
      if ([...mounted.keys()].includes(serverName)) return true
    }
    return false
  }
}

/** Files this plugin's own store wrote; used by the skill provider. */
interface ProviderSkill {
  readonly plugin: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly file: string
  readonly directory: string
}

interface SkillCandidateFile {
  readonly skillName: string
  readonly path: string
  readonly directory: string
  readonly file: string
}

/** One skill root scan: direct `<name>/SKILL.md` dirs plus loose `.md` files. */
async function skillCandidatesOf(skillsDir: string): Promise<SkillCandidateFile[]> {
  const found: SkillCandidateFile[] = []
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.isDirectory()) {
      const path = join(skillsDir, entry.name, 'SKILL.md')
      if (await exists(path)) {
        found.push({ skillName: entry.name, path, directory: dirname(path), file: await readFile(path, 'utf8') })
      }
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const path = join(skillsDir, entry.name)
      found.push({ skillName: entry.name.replace(/\.md$/, ''), path, directory: skillsDir, file: await readFile(path, 'utf8') })
    }
  }
  return found
}

/** The provider registered on `ctx.skills`; serves the enabled plugins' skills. */
class CcSkillProvider implements SkillProviderLike {
  readonly name = PROVIDER_NAME
  private readonly store: CcPluginStore

  constructor(store: CcPluginStore) {
    this.store = store
  }

  async list(): Promise<unknown> {
    const skills = await this.store.listProviderSkills()
    return skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
      provider: this.name,
      source: 'claude-plugin',
      rank: CC_SKILL_RANK,
      locator: { plugin: skill.plugin, file: skill.file },
      resourceBase: { kind: 'directory', path: skill.directory },
      path: skill.file,
    }))
  }

  async get(candidate: unknown): Promise<unknown> {
    const locator = (candidate as { locator?: { file?: string } }).locator
    if (locator?.file === undefined) return undefined
    const raw = await readFile(locator.file, 'utf8').catch(() => undefined)
    if (raw === undefined) return undefined
    const parsed = parseSkillText(raw)
    if (parsed.parseError !== undefined || parsed.name === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description ?? '',
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
      provider: this.name,
      source: 'claude-plugin',
      resourceBase: { kind: 'directory', path: dirname(locator.file) },
      path: locator.file,
      content: parsed.body,
    }
  }
}

/** Read the manifest out of a downloaded file set. */
function readManifest(files: ReadonlyMap<string, Buffer>): Manifest | undefined {
  const bytes = files.get('.claude-plugin/plugin.json') ?? files.get('plugin.json')
  if (bytes === undefined) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as Manifest
  } catch {
    return undefined
  }
}

async function readManifestOf(baseDir: string, plugin: InstalledPlugin): Promise<Manifest> {
  const root = join(baseDir, 'store', plugin.name, plugin.version)
  for (const candidate of ['.claude-plugin/plugin.json', 'plugin.json']) {
    const text = await readFile(join(root, candidate), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    try {
      return JSON.parse(text) as Manifest
    } catch {
      /* try the next location */
    }
  }
  return {}
}

interface ConvertedServer {
  readonly serverName: string
  readonly plain: Record<string, unknown>
}

/** Convert manifest mcpServers through the import converter; warnings collect. */
function convertServers(manifest: Manifest, warnings: string[]): ConvertedServer[] {
  const servers = manifest.mcpServers
  if (servers === undefined || typeof servers !== 'object') return []
  const converted: ConvertedServer[] = []
  let preview
  try {
    preview = convertMcpImport(JSON.stringify({ mcpServers: servers }))
  } catch (cause) {
    warnings.push(`mcpServers could not be converted: ${cause instanceof Error ? cause.message : String(cause)}`)
    return converted
  }
  for (const warning of preview.errors) warnings.push(`mcpServers: ${warning}`)
  for (const entry of preview.entries) {
    warnings.push(...entry.warnings)
    converted.push({
      serverName: entry.config.serverName,
      plain: viewToPlain(entry.config),
    })
  }
  return converted
}

/** View config → the plain record McpClient.Config accepts (!!js markers intact). */
export function viewToPlain(view: McpConfigView): Record<string, unknown> {
  const jsExpr = (value: string): Record<string, string> | string =>
    value.startsWith('!!js ') ? { __jsExpr: value.slice('!!js '.length) } : value
  const recordOf = (record: Readonly<Record<string, string | null>> | undefined): Record<string, unknown> | undefined => {
    if (record === undefined) return undefined
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === '') continue
      out[key] = jsExpr(value)
    }
    return out
  }
  return {
    serverName: view.serverName,
    transport: view.transport,
    ...(view.transport === 'stdio' ? {
      command: view.command,
      ...(view.args !== undefined && view.args.length > 0 ? { args: view.args } : {}),
      ...(recordOf(view.env) !== undefined ? { env: recordOf(view.env) } : {}),
      ...(view.cwd !== undefined && view.cwd !== '' ? { cwd: view.cwd } : {}),
    } : {
      url: view.url,
      ...(recordOf(view.headers) !== undefined ? { headers: recordOf(view.headers) } : {}),
    }),
    ...(view.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: view.toolCallTimeoutMs } : {}),
    ...(view.failOnStartupError !== undefined ? { failOnStartupError: view.failOnStartupError } : {}),
  }
}

/** Content hash of one downloaded file set (path + bytes, sorted). */
function filesContentKey(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const path of [...files.keys()].sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(createHash('sha256').update(files.get(path) as Buffer).digest())
  }
  return hash.digest('hex')
}

/** Content hash of one installed plugin directory; undefined when unreadable. */
async function directoryContentKey(dir: string): Promise<string | undefined> {
  const hash = createHash('sha256')
  const walk = async (relativeDir: string): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(join(dir, relativeDir), { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.staging-')) continue
      const child = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!(await walk(child))) return false
        continue
      }
      if (!entry.isFile()) continue
      const bytes = await readFile(join(dir, child)).catch(() => undefined)
      if (bytes === undefined) return false
      hash.update(child)
      hash.update('\0')
      hash.update(createHash('sha256').update(bytes).digest())
    }
    return true
  }
  return await walk('') ? hash.digest('hex') : undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Keep the newest `.cap-bak-*` copies beside the registry; never blocks a write. */
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

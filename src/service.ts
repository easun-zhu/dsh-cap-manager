/**
 * The capabilityManager Host Remote service: reads the composed MCP-client
 * rows and the skill catalog (`list`), manages MCP rows in the global (home)
 * and profile patch layers with live effect through HMR
 * (`writeMcp` / `removeMcp` / `setMcpEnabled` / `testMcp`), and owns the
 * project layer — `<root>/.dsh/mcp.yml` files mounted as live fibers by the
 * ProjectMounter for projects with live sessions or a pinned panel selection.
 */

import { access, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveAgentsHome } from '@deepseek-ai/dsh-home-paths'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { composedRows, scopeOf } from './scopes.ts'
import { configText, storedPayload, viewConfig } from './config-view.ts'
import { convertMcpImport, exportMcpEntry } from './import-mcp.ts'
import { collectRowFacts, resolveStatus } from './status-tracker.ts'
import { PatchFileError, removeRow, setRowEnabled, upsertRow } from './patch-writer.ts'
import {
  ProjectConfigError, projectMcpPath, readProjectMcp, removeProjectServer,
  setProjectServerEnabled, writeProjectServer,
} from './project-config.ts'
import { ProjectMounter, normalizeRoot } from './project-mounter.ts'
import { CcMarket, httpFetcher, isExactPin, MARKET_NAME } from './cc-market.ts'
import { CcPluginStore } from './cc-store.ts'
import { testMcpConnection } from './mcp-test.ts'
import {
  clearTrashItems, deleteTrashItem, importSkillFiles, listTrashItems, readSkillBundle, readSkillFile, removeSkillToTrash,
  restoreTrashItem, scanSkills, setSkillFlags, skillRootPath, writeSkill, SkillStoreError,
  type SkillHomes, type SkillScopeDir,
} from './skills-store.ts'
import type {
  BackupEntry, CapabilityListResult, CcInstallResult, CcMarketEntryView, CcPluginsListResult, ChangeOutcome, ClearTrashResult,
  ExportMcpResult, ImportPreview, ImportSkillsRequest, ImportSkillsResult, ListRequest, McpConfigView, McpServerEntry,
  McpRowRequest, ProjectInfo, ProjectSummary, ReadSkillRequest, ReadSkillResult, RemoveSkillRequest,
  SetSkillFlagsRequest, SkillBundle, SkillEntry, TestMcpRequest, TestMcpResult, TrashEntry, WriteMcpRequest,
  WriteSkillRequest,
} from './types.ts'

const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const HTTP_TIMEOUT_CEILING = 3_600_000

/** Structural view of the skill registry service (`ctx.skills`). */
interface SkillsRegistryLike {
  snapshot(options?: { cwd?: string }): Promise<{ skills: readonly SkillSummaryLike[] }>
}

/** Structural view of one skill summary from ctx.skills.snapshot(). */
interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly path?: string
  readonly source: string
  readonly invocation?: { modelInvocable: boolean; userInvocable: boolean }
}

/** Structural view of the HMR service (`ctx.hmr`). */
interface HmrLike {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

/** Structural view of the workspace registry (`ctx.workspaceRegistry`). */
interface WorkspaceLike {
  readonly path: string
  readonly title: string
}

/** Structural view of the session store (`ctx.sessions`). */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

interface SessionsLike {
  list(): readonly SessionLike[]
}

const WRITABLE_SOURCES = new Set(['project-dsh', 'project-agents', 'user-dsh', 'user-agents'])

export class CapabilityManagerService extends TypertRemoteService {
  static inject = ['profileContext']

  private readonly profile: ProfileContext
  private readonly mounter: ProjectMounter
  private readonly ccMarket: CcMarket
  private readonly ccStore: CcPluginStore

  constructor(ctx: Context) {
    super(ctx, 'capabilityManager')
    this.profile = (ctx as Context & { profileContext: ProfileContext }).profileContext
    this.mounter = new ProjectMounter(ctx, () => this.patchServerNames())
    this.mounter.start()
    const ccBase = join(this.profile.home, 'cap-manager', 'plugins')
    this.ccMarket = new CcMarket(join(ccBase, 'market.json'), httpFetcher)
    this.ccStore = new CcPluginStore(ctx, this.ccMarket, {
      baseDir: ccBase,
      reservedNames: () => [...this.patchServerNames(), ...this.mounter.mountedServerNames()],
      onChanged: () => undefined,
    })
    ctx.effect(() => () => { void this.ccStore.close() }, 'cap-manager: cc plugin store')
  }

  /**
   * Compose MCP-client rows across every layer, read the global skill catalog,
   * and — when the request names a project — the project's `.dsh/mcp.yml`
   * servers with their live mount status.
   */
  @Remote
  async list(request?: ListRequest): Promise<CapabilityListResult> {
    const rows = composedRows(this.profile)
    const descriptors: {
      id: string; serverName: string; scope: McpServerEntry['scope']
      view: McpConfigView | undefined; summary: string; enabled: boolean
    }[] = []
    for (const row of rows) {
      if (row.name !== MCP_CLIENT_MODULE) continue
      const view = viewConfig(row.config)
      const serverName = view?.serverName ?? configText(row.config, 'serverName') ?? row.id
      const args = Array.isArray((row.config as Record<string, unknown> | undefined)?.args)
        ? ((row.config as Record<string, unknown>).args as unknown[]).filter((arg): arg is string => typeof arg === 'string')
        : []
      const command = configText(row.config, 'command')
      const url = configText(row.config, 'url')
      descriptors.push({
        id: row.id,
        serverName,
        scope: scopeOf(row.id, this.profile),
        view,
        summary: command !== undefined ? [command, ...args].join(' ') : url ?? '',
        enabled: row.disabled !== true,
      })
    }

    const facts = collectRowFacts(this.ctx, descriptors)
    const mcp: McpServerEntry[] = descriptors.map(row => {
      const rowFacts = facts.get(row.id)
      return {
        id: row.id,
        serverName: row.serverName,
        scope: row.scope,
        transport: row.view?.transport ?? 'unknown',
        summary: row.summary,
        enabled: row.enabled,
        status: resolveStatus(row.enabled, rowFacts),
        toolCount: rowFacts?.toolCount,
        config: row.view,
        managed: row.scope !== 'preset',
        ...(rowFacts?.fiberError !== undefined ? { error: rowFacts.fiberError } : {}),
      }
    })

    let project: ProjectSummary | undefined
    let projectRoot: string | undefined
    if (request?.projectRoot !== undefined && request.projectRoot !== '') {
      const root = await normalizeRoot(request.projectRoot)
      projectRoot = root
      const view = await this.mounter.projectView(root)
      for (const server of view.servers) {
        const live = view.status.get(server.serverName)
        mcp.push({
          id: `project/${server.serverName}`,
          serverName: server.serverName,
          scope: 'project',
          transport: server.view?.transport ?? 'unknown',
          summary: summaryOf(server.view),
          enabled: server.enabled,
          status: live?.status ?? (server.enabled ? 'stopped' : 'disabled'),
          toolCount: live?.toolCount,
          config: server.view,
          managed: true,
          ...(live?.error !== undefined ? { error: live.error } : {}),
        })
      }
      project = {
        root,
        title: projectTitle(root),
        active: view.active,
        ...(view.fileError !== undefined ? { fileError: view.fileError } : {}),
      }
    }

    return {
      profileName: this.profile.dir.split(/[\\/]/).filter(Boolean).pop() ?? '',
      mcp,
      skills: await this.listSkills(projectRoot),
      ...(project !== undefined ? { project } : {}),
    }
  }

  /** Every workspace record plus session-held roots, for the project picker. */
  @Remote
  async listProjects(): Promise<readonly ProjectInfo[]> {
    const found = await this.collectProjects()
    const infos: ProjectInfo[] = []
    for (const [root, info] of found) {
      infos.push({
        root,
        title: info.title,
        liveSessions: info.liveSessions,
        hasConfig: await exists(projectMcpPath(root)),
      })
    }
    infos.sort((left, right) =>
      (right.liveSessions - left.liveSessions) || left.title.localeCompare(right.title))
    return infos
  }

  /** Session-held roots ∪ workspace records (realpath-normalized). */
  private async collectProjects(): Promise<Map<string, { title: string; liveSessions: number }>> {
    const sessions = this.ctx.get('sessions') as SessionsLike | undefined
    const liveCounts = new Map<string, number>()
    const roots = new Map<string, string>()
    for (const session of sessions?.list() ?? []) {
      if (session.header.cwd === undefined || session.header.cwd === '') continue
      const root = await normalizeRoot(session.header.cwd)
      liveCounts.set(root, (liveCounts.get(root) ?? 0) + 1)
      roots.set(root, projectTitle(root))
    }
    const registry = this.ctx.get('workspaceRegistry') as { list(): readonly WorkspaceLike[] } | undefined
    for (const workspace of registry?.list() ?? []) {
      const root = await normalizeRoot(workspace.path)
      if (!roots.has(root)) roots.set(root, workspace.title)
    }
    const found = new Map<string, { title: string; liveSessions: number }>()
    for (const [root, title] of roots) found.set(root, { title, liveSessions: liveCounts.get(root) ?? 0 })
    return found
  }

  /** Roots the panel currently knows about (backups scan their project files). */
  private async knownProjectRoots(): Promise<string[]> {
    return [...(await this.collectProjects()).keys()]
  }

  /** Pin (or release) the project whose fibers stay mounted for the panel. */
  @Remote
  async setActiveProject(request: { root?: string }): Promise<void> {
    const root = request?.root === undefined || request.root === '' ? undefined : await normalizeRoot(request.root)
    this.mounter.setLockedRoot(root)
  }

  /** Insert or replace one MCP server in the requested layer. */
  @Remote
  async writeMcp(request: WriteMcpRequest): Promise<ChangeOutcome> {
    const config = validateConfig(request.config)
    const serverName = config.serverName
    if (request.scope === 'project') {
      const root = await this.projectRootOf(request)
      this.assertNameFree(serverName)
      const file = await readProjectMcp(root)
      if (file.error !== undefined) throw new RemoteError('cap/yaml-invalid', file.error, {})
      await this.projectEdit(() => writeProjectServer(root, config, request.enabled))
      return await this.projectOutcome(root, [`server ${serverName} written to ${projectMcpPath(root)}`])
    }

    const id = `mcp-${serverName}`
    const rows = composedRows(this.profile)
    for (const row of rows) {
      if (row.id === id && row.name !== MCP_CLIENT_MODULE) {
        throw new RemoteError('cap/name-conflict', `entry id ${id} is already used by another plugin row`, {})
      }
      if (row.name !== MCP_CLIENT_MODULE || row.id === id) continue
      const other = configText(row.config, 'serverName')
      if (other === serverName) {
        throw new RemoteError('cap/name-conflict', `serverName ${serverName} already exists (entry ${row.id})`, {})
      }
    }

    const file = this.patchFileOf(request.scope)
    const existing = rows.find(row => row.id === id && scopeOf(row.id, this.profile) === request.scope)
    const merged = storedPayload(config, existing?.config)

    await this.exclusive(async () => {
      await upsertRow(file, { id, name: MCP_CLIENT_MODULE, config: merged }, request.enabled ? undefined : true)
    })
    return this.changedOutcome([`row ${id} written to the ${request.scope} layer`])
  }

  /** Remove one MCP server from the requested layer. */
  @Remote
  async removeMcp(request: McpRowRequest): Promise<ChangeOutcome> {
    if (request.scope === 'project') {
      const root = await this.projectRootOf(request)
      const changed = await this.projectEdit(() => removeProjectServer(root, request.serverName))
      if (!changed) throw new RemoteError('cap/not-found', `no MCP server ${request.serverName} in the project file`, {})
      return await this.projectOutcome(root, [`server ${request.serverName} removed from the project file`])
    }
    const scope: 'global' | 'profile' = request.scope
    const { id } = this.locate(request)
    await this.exclusive(async () => {
      await removeRow(this.patchFileOf(scope), id)
    })
    return this.changedOutcome([`row ${id} removed from the ${scope} layer`])
  }

  /** Toggle one MCP server without touching its config. */
  @Remote
  async setMcpEnabled(request: McpRowRequest): Promise<ChangeOutcome> {
    if (request.scope === 'project') {
      const root = await this.projectRootOf(request)
      const changed = await this.projectEdit(() => setProjectServerEnabled(root, request.serverName, request.enabled === true))
      if (!changed) throw new RemoteError('cap/not-found', `no MCP server ${request.serverName} in the project file`, {})
      return await this.projectOutcome(
        root,
        [`server ${request.serverName} ${request.enabled === true ? 'enabled' : 'disabled'} in the project file`],
      )
    }
    const scope: 'global' | 'profile' = request.scope
    const { id } = this.locate(request)
    await this.exclusive(async () => {
      await setRowEnabled(this.patchFileOf(scope), id, request.enabled === true)
    })
    return this.changedOutcome([`row ${id} ${request.enabled === true ? 'enabled' : 'disabled'}`])
  }

  /** Connect once with the candidate config through the SDK; registers no tools. */
  @Remote
  async testMcp(request: TestMcpRequest): Promise<TestMcpResult> {
    return await testMcpConnection(unmaskForTest(request.config), request.timeoutMs)
  }

  /** Create or overwrite one SKILL.md in the requested root bucket. */
  @Remote
  async writeSkill(request: WriteSkillRequest): Promise<ChangeOutcome> {
    const homes = await this.skillHomesOf(request)
    const root = skillRootPath(request.scopeDir, homes)
    let outcome: { file: string; created: boolean }
    try {
      outcome = await writeSkill(root, {
        name: request.name,
        description: request.description,
        ...(request.whenToUse !== undefined ? { whenToUse: request.whenToUse } : {}),
        body: request.body,
        modelInvocable: request.modelInvocable,
        userInvocable: request.userInvocable,
      })
    } catch (error) {
      this.skillError(error)
    }
    const warnings = [`${request.name} ${outcome.created ? 'created at' : 'updated at'} ${outcome.file}`]
    warnings.push(...await this.shadowWarnings(request.name, outcome.file, homes))
    return { applied: true, live: true, warnings }
  }

  /** Flip one skill's invocation flags without touching its body. */
  @Remote
  async setSkillFlagsRpc(request: SetSkillFlagsRequest): Promise<ChangeOutcome> {
    const file = this.requireWritableSkill(request.path)
    try {
      await setSkillFlags(file, {
        ...(request.modelInvocable !== undefined ? { modelInvocable: request.modelInvocable } : {}),
        ...(request.userInvocable !== undefined ? { userInvocable: request.userInvocable } : {}),
      })
    } catch (error) {
      this.skillError(error)
    }
    return { applied: true, live: true, warnings: [`flags updated on ${file}`] }
  }

  /** Move one skill into the plugin trash; a same-name twin surfacing is a warning. */
  @Remote
  async removeSkillRpc(request: RemoveSkillRequest): Promise<ChangeOutcome> {
    const file = this.requireWritableSkill(request.path)
    let name: string
    try {
      name = (await readSkillFile(file)).name
    } catch (error) {
      this.skillError(error)
    }
    const homes = await this.skillHomesOf()
    let trash: string
    try {
      trash = await removeSkillToTrash(file, join(this.profile.home, 'cap-manager', 'trash'))
    } catch (error) {
      this.skillError(error)
    }
    const warnings = [`${name} moved to ${trash}`]
    warnings.push(...await this.shadowWarnings(name, file, homes))
    return { applied: true, live: true, warnings }
  }

  /** Read one writable SKILL.md for the detail editor. */
  @Remote
  async readSkillRpc(request: ReadSkillRequest): Promise<ReadSkillResult> {
    const file = this.requireWritableSkill(request.path)
    try {
      return await readSkillFile(file)
    } catch (error) {
      this.skillError(error)
    }
  }

  // ---- import / export / trash / backups (DESIGN.md §7, §10) ----

  /** Parse one mcpServers document into converted entries + warnings; no writes. */
  @Remote
  async previewMcpImport(request: { json: string }): Promise<ImportPreview> {
    try {
      return convertMcpImport(request.json)
    } catch (error) {
      throw new RemoteError('cap/yaml-invalid', error instanceof Error ? error.message : String(error), {})
    }
  }

  /**
   * Merge every managed row (plus one project's file) into a standard mcpServers
   * document; `serverName` narrows the export to that single row, which also
   * exports when disabled (the click is an explicit ask, unlike a bulk dump).
   */
  @Remote
  async exportMcp(request?: { projectRoot?: string, serverName?: string }): Promise<ExportMcpResult> {
    const only = request?.serverName !== undefined && request.serverName !== '' ? request.serverName : undefined
    const servers: Record<string, unknown> = {}
    let skipped = 0
    for (const row of composedRows(this.profile)) {
      if (row.name !== MCP_CLIENT_MODULE) continue
      const view = viewConfig(row.config)
      const serverName = view?.serverName ?? configText(row.config, 'serverName') ?? row.id
      if (only !== undefined && serverName !== only) continue
      if (row.disabled === true && only === undefined) {
        skipped += 1
        continue
      }
      const exported = exportMcpEntry(row.config)
      if (exported !== undefined) servers[serverName] = exported
    }
    if (request?.projectRoot !== undefined && request.projectRoot !== '') {
      const root = await normalizeRoot(request.projectRoot)
      const file = await readProjectMcp(root)
      if (file.error !== undefined) throw new RemoteError('cap/yaml-invalid', file.error, {})
      for (const server of file.servers) {
        if (only !== undefined && server.serverName !== only) continue
        if (!server.enabled && only === undefined) {
          skipped += 1
          continue
        }
        const exported = exportMcpEntry({ ...server.raw, serverName: server.serverName })
        if (exported !== undefined) servers[server.serverName] = exported
      }
    }
    if (only !== undefined && Object.keys(servers).length === 0) {
      throw new RemoteError('cap/not-found', `MCP server ${only} is not present in the exportable layers`, {})
    }
    return { json: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, skipped }
  }

  /** Import skills from an extracted archive/folder listing into one bucket. */
  @Remote
  async importSkills(request: ImportSkillsRequest): Promise<ImportSkillsResult> {
    const homes = await this.skillHomesOf(request)
    const root = skillRootPath(request.scopeDir, homes)
    try {
      return await importSkillFiles(root, request.files, request.overwrite)
    } catch (error) {
      this.skillError(error)
    }
  }

  /** Read one writable skill (directory walk or single file) as base64 payloads. */
  @Remote
  async readSkillBundleRpc(request: { path: string }): Promise<SkillBundle> {
    const file = this.requireWritableSkill(request.path)
    try {
      return await readSkillBundle(file)
    } catch (error) {
      this.skillError(error)
    }
  }

  /** Every trash item, newest first. */
  @Remote
  async listTrash(): Promise<readonly TrashEntry[]> {
    return await listTrashItems(this.trashBase())
  }

  /** Restore one trash item to its original path. */
  @Remote
  async restoreTrash(request: { id: string }): Promise<ChangeOutcome> {
    let restored: string
    try {
      restored = await restoreTrashItem(this.trashBase(), request.id)
    } catch (error) {
      this.skillError(error)
    }
    return { applied: true, live: true, warnings: [`restored to ${restored}`] }
  }

  /** Destroy one trash item permanently. */
  @Remote
  async deleteTrash(request: { id: string }): Promise<ChangeOutcome> {
    try {
      await deleteTrashItem(this.trashBase(), request.id)
    } catch (error) {
      this.skillError(error)
    }
    return { applied: true, live: true, warnings: [`${request.id} deleted permanently`] }
  }

  /** Destroy every trash item permanently. */
  @Remote
  async clearTrash(): Promise<ClearTrashResult> {
    const count = await clearTrashItems(this.trashBase())
    return { applied: true, live: true, warnings: [], count }
  }

  /** `.cap-bak-*` copies beside every managed file (patches, project files, skills). */
  @Remote
  async listBackups(): Promise<readonly BackupEntry[]> {
    const found = new Map<string, BackupEntry>()
    for (const target of await this.backupTargets()) {
      const names = await readdir(dirname(target)).catch(() => [] as string[])
      const prefix = `${basename(target)}.cap-bak-`
      for (const name of names) {
        if (!name.startsWith(prefix)) continue
        const file = join(dirname(target), name)
        const time = parseBackupStamp(name.slice(prefix.length))
        const size = await stat(file).then(info => info.size, () => 0)
        found.set(file, { file, target, size, ...(time !== undefined ? { time } : {}) })
      }
    }
    return [...found.values()]
      .sort((left, right) => (right.time ?? right.file).localeCompare(left.time ?? left.file))
      .slice(0, 100)
  }

  /** Copy one backup back over its managed file (HMR and watchers pick it up). */
  @Remote
  async restoreBackup(request: { file: string }): Promise<ChangeOutcome> {
    const hit = (await this.listBackups()).find(entry => entry.file === request.file)
    if (hit === undefined) throw new RemoteError('cap/not-found', `no managed backup at ${request.file}`, {})
    const data = await readFile(hit.file)
    await writeFileAtomic(hit.target, data, { mode: 0o600 })
    return this.changedOutcome([`${hit.target} restored from ${basename(hit.file)}`])
  }

  /** Delete one backup copy. */
  @Remote
  async deleteBackup(request: { file: string }): Promise<void> {
    const hit = (await this.listBackups()).find(entry => entry.file === request.file)
    if (hit === undefined) throw new RemoteError('cap/not-found', `no managed backup at ${request.file}`, {})
    await unlink(hit.file)
  }

  // ---- Claude Code plugin source (M6) ----

  /** Marketplace listing merged with the installed overlay and update pins. */
  @Remote
  async listCcPlugins(request?: { refresh?: boolean }): Promise<CcPluginsListResult> {
    const market = await this.ccMarket.list(request?.refresh === true)
    const installed = new Map(this.ccStore.installed().map(plugin => [plugin.name, plugin]))
    const entries: CcMarketEntryView[] = []
    for (const entry of market.entries) {
      const hit = installed.get(entry.name)
      // The current pin of every source kind: the entry's own sha for git
      // sources, the marketplace HEAD sha for in-repo (path) sources. Pins of
      // different exactness (sha vs a timestamp fallback) never flag: unknown
      // is not "changed".
      const currentPin = typeof entry.source === 'object' && entry.source.sha !== undefined
        ? entry.source.sha
        : market.pin
      entries.push({
        name: entry.name,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.author?.name !== undefined ? { author: entry.author.name } : {}),
        ...(entry.category !== undefined ? { category: entry.category } : {}),
        ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
        ...(hit !== undefined ? {
          installed: {
            version: hit.version,
            enabled: hit.enabled,
            skills: hit.skillNames.length,
            servers: await this.ccStore.serverStatuses(hit.name),
            skippedContent: hit.skippedContent,
            updatedAt: hit.updatedAt,
            updateAvailable: currentPin !== hit.pin && isExactPin(currentPin) === isExactPin(hit.pin),
          },
        } : {}),
      })
    }
    return { marketName: MARKET_NAME, fetchedAt: new Date(market.fetchedAt).toISOString(), entries }
  }

  /** Download and activate one marketplace plugin (skills provider + MCP mounts). */
  @Remote
  async installCcPlugin(request: { name: string }): Promise<CcInstallResult> {
    const market = await this.ccMarket.list(false)
    const entry = market.entries.find(candidate => candidate.name === request.name)
    if (entry === undefined) throw new RemoteError('cap/not-found', `no marketplace plugin named "${request.name}"`, {})
    const outcome = await this.ccStore.install(entry, market.pin)
    return { ...outcome, applied: true, live: true }
  }

  /** Re-resolve one plugin against the fresh marketplace and reinstall if moved. */
  @Remote
  async updateCcPlugin(request: { name: string }): Promise<CcInstallResult & { upToDate: boolean }> {
    const market = await this.ccMarket.list(true)
    const entry = market.entries.find(candidate => candidate.name === request.name)
    if (entry === undefined) throw new RemoteError('cap/not-found', `no marketplace plugin named "${request.name}"`, {})
    const installed = this.ccStore.installedByName(request.name)
    if (installed === undefined) throw new RemoteError('cap/not-found', `plugin "${request.name}" is not installed`, {})
    const nextPin = typeof entry.source === 'object' && entry.source.sha !== undefined ? entry.source.sha : market.pin
    if (nextPin === installed.pin) return { name: request.name, version: installed.version, skills: [], servers: [], warnings: [], skippedContent: [], applied: false, live: true, upToDate: true }
    const outcome = await this.ccStore.install(entry, market.pin, true)
    // `unchanged`: the download was byte-identical, only the pin moved.
    return { ...outcome, applied: outcome.unchanged !== true, live: true, upToDate: outcome.unchanged === true }
  }

  @Remote
  async uninstallCcPlugin(request: { name: string }): Promise<ChangeOutcome> {
    await this.ccStore.uninstall(request.name)
    return { applied: true, live: true }
  }

  /** Flip one plugin's skills and MCP servers on or off; takes effect live. */
  @Remote
  async setCcPluginEnabled(request: { name: string; enabled: boolean }): Promise<ChangeOutcome> {
    await this.ccStore.setEnabled(request.name, request.enabled)
    return { applied: true, live: true }
  }

  private trashBase(): string {
    return join(this.profile.home, 'cap-manager', 'trash')
  }

  /** Managed files whose `.cap-bak-*` siblings are worth listing. */
  private async backupTargets(): Promise<string[]> {
    const targets = new Set<string>([this.profile.patchPath, join(this.profile.home, PROFILE_PATCH_FILENAME)])
    const homes: SkillHomes[] = [{ dshHome: this.profile.home, agentsHome: resolveAgentsHome() }]
    for (const root of await this.knownProjectRoots()) {
      targets.add(projectMcpPath(root))
      homes.push({ dshHome: this.profile.home, agentsHome: resolveAgentsHome(), projectRoot: root })
    }
    for (const home of homes) {
      const scan = await scanSkills(home).catch(() => [] as Awaited<ReturnType<typeof scanSkills>>)
      for (const skill of scan) targets.add(skill.file)
    }
    return [...targets]
  }

  /** Resolve the homes for a skill request; project buckets need a usable root. */
  private async skillHomesOf(request?: { readonly scopeDir?: SkillScopeDir; readonly projectRoot?: string }): Promise<SkillHomes> {
    if (request?.scopeDir === 'project-dsh' || request?.scopeDir === 'project-agents') {
      return {
        dshHome: this.profile.home,
        agentsHome: resolveAgentsHome(),
        projectRoot: await this.projectRootOf(request),
      }
    }
    return { dshHome: this.profile.home, agentsHome: resolveAgentsHome() }
  }

  /** Describe same-name siblings after a write or delete: who shadows whom. */
  private async shadowWarnings(name: string, file: string, homes: SkillHomes): Promise<string[]> {
    const scan = await scanSkills(homes).catch(() => [])
    const mine = scan.find(entry => entry.name === name && entry.file === file)
    const warnings: string[] = []
    for (const other of scan.filter(entry => entry.name === name && entry.file !== file && entry.parseError === undefined)
      .sort((left, right) => left.rank - right.rank)) {
      if (mine !== undefined && mine.rank < other.rank) {
        warnings.push(`this entry shadows ${other.scopeDir}: ${other.file}`)
      } else {
        warnings.push(`${other.scopeDir} entry ${other.file} now holds the "${name}" catalog slot`)
      }
    }
    return warnings
  }

  /** Accept any file under a `<.dsh|.agents>/skills/` root; resolved absolute. */
  private requireWritableSkill(path: string): string {
    const file = resolve(path)
    const nameDir = dirname(file)
    const root = basename(file) === 'SKILL.md' ? dirname(nameDir) : nameDir
    const layer = basename(dirname(root))
    if (basename(root) === 'skills' && (layer === '.dsh' || layer === '.agents')) return file
    this.skillError(new SkillStoreError(`path is not a managed skill file: ${path}`, 'cap/readonly'))
  }

  /** Map SkillStoreError codes onto the wire; everything else propagates. */
  private skillError(error: unknown): never {
    if (error instanceof SkillStoreError) {
      throw new RemoteError(error.code, error.message, {})
    }
    throw error
  }

  /** Resolve the row id for scope-targeted operations; read-only scopes fail loudly. */
  private locate(request: McpRowRequest): { id: string } {
    for (const row of composedRows(this.profile)) {
      if (row.name !== MCP_CLIENT_MODULE) continue
      if (scopeOf(row.id, this.profile) !== request.scope) continue
      if (configText(row.config, 'serverName') !== request.serverName) continue
      return { id: row.id }
    }
    throw new RemoteError('cap/not-found', `no MCP server ${request.serverName} in the ${request.scope} layer`, {})
  }

  private patchFileOf(scope: 'global' | 'profile'): string {
    return scope === 'global'
      ? join(this.profile.home, PROFILE_PATCH_FILENAME)
      : this.profile.patchPath
  }

  /** Canonical project root of a project-scope request (existence-checked). */
  private async projectRootOf(request: { projectRoot?: string }): Promise<string> {
    if (request.projectRoot === undefined || request.projectRoot.trim() === '') {
      throw new RemoteError('cap/no-project', 'the project scope requires a projectRoot', {})
    }
    return await normalizeRoot(request.projectRoot)
  }

  /** Reject a serverName already owned by any patch-layer row (enabled or not). */
  private assertNameFree(serverName: string): void {
    for (const row of composedRows(this.profile)) {
      if (row.name !== MCP_CLIENT_MODULE) continue
      if (configText(row.config, 'serverName') === serverName) {
        throw new RemoteError('cap/name-conflict', `serverName ${serverName} already exists (entry ${row.id})`, {})
      }
    }
  }

  /** Run one project-file edit, mapping file failures to the wire code. */
  private async projectEdit(operation: () => Promise<boolean>): Promise<boolean> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProjectConfigError) {
        throw new RemoteError('cap/yaml-invalid', error.message, {})
      }
      throw error
    }
  }

  /** Re-diff the project's fibers and describe what reached the runtime. */
  private async projectOutcome(root: string, warnings: readonly string[]): Promise<ChangeOutcome> {
    await this.mounter.refresh(root)
    if (!this.mounter.isActive(root)) {
      return {
        applied: true,
        live: true,
        warnings: [...warnings, 'no live session in this project; servers mount when one starts or the panel pins it'],
      }
    }
    return { applied: true, live: true, warnings }
  }

  /** serverNames owned by patch rows, enabled or disabled. */
  private patchServerNames(): ReadonlySet<string> {
    const names = new Set<string>()
    for (const row of composedRows(this.profile)) {
      if (row.name !== MCP_CLIENT_MODULE) continue
      const name = configText(row.config, 'serverName')
      if (name !== undefined) names.add(name)
    }
    return names
  }

  /** Serialize patch writes with HMR's own recomposition queue when present. */
  private async exclusive(operation: () => Promise<unknown>): Promise<void> {
    const hmr = this.ctx.get('hmr') as HmrLike | undefined
    try {
      if (hmr === undefined) await operation()
      else await hmr.runExclusive(async () => { await operation() })
    } catch (error) {
      if (error instanceof PatchFileError) {
        throw new RemoteError('cap/yaml-invalid', error.message, {})
      }
      throw error
    }
  }

  private changedOutcome(warnings: readonly string[]): ChangeOutcome {
    const hmr = this.ctx.get('hmr') as HmrLike | undefined
    return hmr === undefined
      ? { applied: true, live: false, restartRequired: true, warnings }
      : { applied: true, live: true, warnings }
  }

  /**
   * Skill catalog: this plugin's own scan of the writable roots, with
   * duplicates resolved by the provider's own rank order (lower wins) — the
   * provider's snapshot cannot be trusted for precedence because it reads
   * non-bundled roots through the sandboxed fs layer, which may hide them.
   * The snapshot only contributes entries from sources my scan cannot see
   * (bundled / runtime / custom providers).
   */
  private async listSkills(projectRoot?: string): Promise<readonly SkillEntry[]> {
    const homes: SkillHomes = {
      dshHome: this.profile.home,
      agentsHome: resolveAgentsHome(),
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    }
    const scan = await scanSkills(homes).catch(() => [] as Awaited<ReturnType<typeof scanSkills>>)

    const entries: SkillEntry[] = []
    const scannedNames = new Set<string>()
    const byName = new Map<string, typeof scan>()
    for (const scanned of scan) {
      const group = byName.get(scanned.name) ?? []
      group.push(scanned)
      byName.set(scanned.name, group)
    }
    for (const [name, group] of byName) {
      scannedNames.add(name)
      const sorted = [...group].sort((left, right) => left.rank - right.rank)
      for (const [at, scanned] of sorted.entries()) {
        const winner = sorted[0]
        entries.push({
          name,
          description: scanned.description,
          ...(scanned.whenToUse !== undefined ? { whenToUse: scanned.whenToUse } : {}),
          source: scanned.scopeDir,
          scope: skillScope(scanned.scopeDir),
          path: scanned.file,
          modelInvocable: scanned.modelInvocable,
          userInvocable: scanned.userInvocable,
          writable: true,
          ...(at > 0 && winner !== undefined ? { shadowed: true, shadowedBy: winner.file } : {}),
          ...(scanned.parseError !== undefined ? { error: scanned.parseError } : {}),
        })
      }
    }

    const registry = this.ctx.get('skills') as SkillsRegistryLike | undefined
    if (registry !== undefined) {
      const snapshot = await registry.snapshot(projectRoot !== undefined ? { cwd: projectRoot } : {})
      for (const skill of snapshot.skills) {
        if (scannedNames.has(skill.name)) continue
        entries.push({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
          source: skill.source,
          scope: skillScope(skill.source),
          path: skill.path,
          modelInvocable: skill.invocation?.modelInvocable ?? true,
          userInvocable: skill.invocation?.userInvocable ?? true,
          writable: WRITABLE_SOURCES.has(skill.source),
        })
      }
    }
    return entries
  }
}

/** Validate the wire config; returns the normalized write payload fields. */
function validateConfig(view: McpConfigView): McpConfigView {
  if (view.transport !== 'stdio' && view.transport !== 'streamable-http') {
    throw new RemoteError('cap/invalid-config', 'transport must be stdio or streamable-http', {})
  }
  if (typeof view.serverName !== 'string' || !SERVER_NAME.test(view.serverName)) {
    throw new RemoteError('cap/invalid-config', 'serverName must match [A-Za-z0-9_-]{1,32}', {})
  }
  if (view.transport === 'stdio' && (typeof view.command !== 'string' || view.command === '')) {
    throw new RemoteError('cap/invalid-config', 'stdio transport requires a non-empty command', {})
  }
  if (view.transport === 'streamable-http'
    && (typeof view.url !== 'string' || !(/^https?:\/\//.test(view.url) || view.url.startsWith('!!js ')))) {
    throw new RemoteError('cap/invalid-config', 'streamable-http transport requires an http(s) url or a !!js expression', {})
  }
  if (view.args !== undefined && view.args.some(arg => typeof arg !== 'string')) {
    throw new RemoteError('cap/invalid-config', 'args must be strings', {})
  }
  if (view.toolCallTimeoutMs !== undefined
    && (!Number.isInteger(view.toolCallTimeoutMs) || view.toolCallTimeoutMs <= 0 || view.toolCallTimeoutMs > HTTP_TIMEOUT_CEILING)) {
    throw new RemoteError('cap/invalid-config', 'toolCallTimeoutMs must be a positive integer of milliseconds', {})
  }
  return view
}

/** Replace masked nulls with empty strings so the tester treats them as unset. */
function unmaskForTest(view: McpConfigView): McpConfigView {
  const fill = (record: Readonly<Record<string, string | null>> | undefined): Record<string, string> | undefined => {
    if (record === undefined) return undefined
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value ?? '']))
  }
  return { ...view, env: fill(view.env), headers: fill(view.headers) }
}

/** One-line command or URL summary for a project server view. */
function summaryOf(view: McpConfigView | undefined): string {
  if (view === undefined) return ''
  if (view.transport === 'stdio') return [view.command ?? '', ...(view.args ?? [])].join(' ')
  return view.url ?? ''
}

/** Display title of one project root (final path segment). */
function projectTitle(root: string): string {
  const segment = root.split(/[\\/]/).filter(Boolean).pop()
  return segment === undefined || segment === '' ? root : segment
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function skillScope(source: string): SkillEntry['scope'] {
  if (source.startsWith('project-')) return 'project'
  if (source.startsWith('user-')) return 'user'
  return 'plugin'
}

/** `2026-10-29T08-30-12-123Z` backup stamps (colons/dots dashed) → ISO timestamp. */
function parseBackupStamp(stamp: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp)
  if (match === null) return undefined
  const date = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]),
  ))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

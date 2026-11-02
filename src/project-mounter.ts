/**
 * ProjectMounter (DESIGN.md §6.5, decision D3): mounts the MCP servers of
 * `<root>/.dsh/mcp.yml` as live mcp-client fibers in this plugin's own scope,
 * for exactly the projects that need them — every root holding a live session,
 * plus the root the manager panel has locked for inspection. The file is the
 * source of truth: a Chokidar watch (the skills watcher's strategy) re-diffs
 * external edits, and every managed write re-runs the same diff directly.
 * Tools registered here are Host-visible while mounted (scope semantics in
 * dsh-scope); per-Agent isolation is a future refinement noted in DESIGN.md.
 */

import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import chokidar from 'chokidar'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { projectMcpPath, readProjectMcp, type ProjectServerEntry } from './project-config.ts'
import { collectToolCounts, fiberFacts, resolveStatus, type FiberLike } from './status-tracker.ts'
import type { McpStatus } from './types.ts'

/** Structural view of one live Session (`ctx.sessions`). */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

/** Structural view of the session store service. */
interface SessionsLike {
  list(): readonly SessionLike[]
}

/** One mounted server fiber and the config fingerprint it was mounted from. */
interface Mounted {
  readonly fiber: Fiber
  readonly configKey: string
}

/** Per-root tracking state: watch handle, mounted fibers, and mount errors. */
interface RootState {
  readonly mounted: Map<string, Mounted>
  readonly errors: Map<string, string>
  watcher: ReturnType<typeof chokidar.watch> | undefined
  refreshTail: Promise<void>
}

/** Status view of one project server as consumed by `list`. */
export interface ProjectServerStatus {
  readonly status: McpStatus
  /** Registered tool count; undefined when the runtime exposes no tool listing. */
  readonly toolCount: number | undefined
  readonly error: string | undefined
}

/** Reply of `projectView`: file-level health plus per-server live status. */
export interface ProjectView {
  readonly servers: readonly ProjectServerEntry[]
  readonly fileError: string | undefined
  readonly active: boolean
  readonly status: ReadonlyMap<string, ProjectServerStatus>
}

const WATCH_STABILITY_MS = 250
const WATCH_POLL_MS = 100

/**
 * Keep one project's MCP servers mounted while the project is in use.
 * Constructed by the Host service; every registration lands on `ctx`, so a
 * plugin unload tears down watchers and fibers with it.
 */
export class ProjectMounter {
  private readonly roots = new Map<string, RootState>()
  private readonly sessionRoots = new Map<string, string>()
  private lockedRoot: string | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly reservedServerNames: () => ReadonlySet<string>,
  ) {}

  /** Index live sessions and follow session starts and ends from here on. */
  start(): void {
    this.ctx.on('session/created', session => { void this.addSession(session) })
    this.ctx.on('session/disposed', session => { void this.dropSession(session.id) })
    const sessions = this.ctx.get('sessions') as SessionsLike | undefined
    for (const session of sessions?.list() ?? []) void this.addSession(session)
    this.ctx.effect(() => () => { void this.close() }, 'cap-manager: project mounter')
  }

  /** The root the manager panel has pinned; keeps its fibers without sessions. */
  setLockedRoot(root: string | undefined): void {
    const previous = this.lockedRoot
    this.lockedRoot = root
    if (previous !== undefined && previous !== root) void this.releaseIfUnused(previous)
    if (root !== undefined) void this.ensureRoot(root)
  }

  /** Whether one root currently holds mounts (or would hold them on refresh). */
  isActive(root: string): boolean {
    return this.roots.has(root)
  }

  /** Every root the mounter currently tracks (sessions ∪ lock). */
  activeRoots(): readonly string[] {
    return [...this.roots.keys()]
  }

  /** serverNames currently mounted across every tracked root. */
  mountedServerNames(): readonly string[] {
    const names: string[] = []
    for (const state of this.roots.values()) {
      for (const name of state.mounted.keys()) names.push(name)
    }
    return names
  }

  /**
   * Re-read one root's file and diff its fibers. Serialized per root so a
   * watcher burst and a managed write cannot interleave; resolving means the
   * resulting fiber set matches the file.
   */
  refresh(root: string): Promise<void> {
    const state = this.roots.get(root)
    if (state === undefined) return Promise.resolve()
    state.refreshTail = state.refreshTail.then(() => this.diff(root, state)).catch(error => {
      this.ctx.logger.warn(`cap-manager: project refresh for ${root} failed: ${String(error)}`)
    })
    return state.refreshTail
  }

  /** Snapshot for `list`: parsed servers with live status for the given root. */
  async projectView(root: string): Promise<ProjectView> {
    const file = await readProjectMcp(root)
    const state = this.roots.get(root)
    const status = new Map<string, ProjectServerStatus>()
    if (state === undefined) {
      for (const server of file.servers) {
        status.set(server.serverName, { status: server.enabled ? 'stopped' : 'disabled', toolCount: 0, error: undefined })
      }
      return { servers: file.servers, fileError: file.error, active: false, status }
    }
    const counts = collectToolCounts(this.ctx, file.servers.map(server => server.serverName))
    for (const server of file.servers) {
      if (!server.enabled) {
        status.set(server.serverName, { status: 'disabled', toolCount: 0, error: undefined })
        continue
      }
      const mounted = state.mounted.get(server.serverName)
      const error = state.errors.get(server.serverName) ?? server.evalError
      const facts = mounted === undefined
        ? undefined
        : fiberFacts(mounted.fiber as unknown as FiberLike, counts?.get(server.serverName))
      status.set(server.serverName, {
        status: error !== undefined ? 'failed' : resolveStatus(true, facts),
        toolCount: facts?.toolCount,
        error,
      })
    }
    return { servers: file.servers, fileError: file.error, active: true, status }
  }

  private async addSession(session: SessionLike): Promise<void> {
    const cwd = session.header.cwd
    if (cwd === undefined || cwd === '') return
    const root = await this.normalizeRoot(cwd)
    if (this.disposed) return
    this.sessionRoots.set(session.id, root)
    await this.ensureRoot(root)
  }

  private async dropSession(sessionId: string): Promise<void> {
    const root = this.sessionRoots.get(sessionId)
    if (root === undefined) return
    this.sessionRoots.delete(sessionId)
    await this.releaseIfUnused(root)
  }

  private async releaseIfUnused(root: string): Promise<void> {
    if (this.disposed) return
    if (this.lockedRoot === root) return
    for (const held of this.sessionRoots.values()) {
      if (held === root) return
    }
    await this.disposeRoot(root)
  }

  private async ensureRoot(root: string): Promise<void> {
    if (this.disposed || this.roots.has(root)) return
    const state: RootState = { mounted: new Map(), errors: new Map(), watcher: undefined, refreshTail: Promise.resolve() }
    this.roots.set(root, state)
    state.watcher = chokidar.watch(projectMcpPath(root), {
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: WATCH_STABILITY_MS, pollInterval: WATCH_POLL_MS },
    })
    state.watcher.on('all', () => { void this.refresh(root) })
    state.watcher.on('error', error => {
      this.ctx.logger.warn(`cap-manager: project watcher for ${root} failed: ${String(error)}`)
    })
    await this.refresh(root)
  }

  private async disposeRoot(root: string): Promise<void> {
    const state = this.roots.get(root)
    if (state === undefined) return
    this.roots.delete(root)
    await state.refreshTail
    await state.watcher?.close().catch(() => undefined)
    await Promise.allSettled([...state.mounted.values()].map(entry => entry.fiber.dispose()))
    state.mounted.clear()
    state.errors.clear()
  }

  /** The actual diff: mount new/changed servers, dispose stale or conflicting ones. */
  private async diff(root: string, state: RootState): Promise<void> {
    if (this.disposed) return
    const file = await readProjectMcp(root)
    state.errors.clear()

    const reserved = this.reservedServerNames()
    const takenElsewhere = new Set<string>()
    for (const other of this.roots.keys()) {
      if (other === root) continue
      for (const name of this.roots.get(other)?.mounted.keys() ?? []) takenElsewhere.add(name)
    }

    const desired = new Map<string, { plain: Record<string, unknown>; key: string }>()
    for (const server of file.servers) {
      if (!server.enabled || server.plain === undefined) continue
      if (reserved.has(server.serverName)) {
        state.errors.set(server.serverName, `serverName ${server.serverName} conflicts with a global/profile MCP row`)
        continue
      }
      if (takenElsewhere.has(server.serverName)) {
        state.errors.set(server.serverName, `serverName ${server.serverName} is already mounted for another active project`)
        continue
      }
      desired.set(server.serverName, { plain: server.plain, key: JSON.stringify(server.plain) })
    }

    for (const [name, entry] of [...state.mounted]) {
      const next = desired.get(name)
      if (next === undefined || next.key !== entry.configKey) {
        state.mounted.delete(name)
        await entry.fiber.dispose().catch(() => undefined)
      }
    }
    for (const [name, entry] of desired) {
      if (state.mounted.has(name)) continue
      try {
        const config = McpClient.Config(entry.plain as Parameters<typeof McpClient.Config>[0])
        const fiber = this.ctx.plugin(McpClient, config)
        state.mounted.set(name, { fiber, configKey: entry.key })
      } catch (error) {
        state.errors.set(name, `invalid config: ${error instanceof Error ? error.message : String(error)}`)
        this.ctx.logger.warn(`cap-manager: mounting project server ${name} failed: ${String(error)}`)
      }
    }
  }

  private async normalizeRoot(path: string): Promise<string> {
    return await normalizeRoot(path)
  }

  /** Close watchers and dispose every fiber; plugin teardown path. */
  async close(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.roots.keys()].map(root => this.disposeRoot(root)))
    this.sessionRoots.clear()
  }
}

/** Canonicalize one path for use as a root key (realpath, falling back as-is). */
export async function normalizeRoot(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Walk up from `cwd` to the nearest `.git` directory, falling back to `cwd`
 * itself — the same semantics as the skills filesystem provider's project
 * root discovery.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  for (;;) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

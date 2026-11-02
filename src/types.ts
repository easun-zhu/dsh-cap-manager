/**
 * Wire types shared by the dsh-cap-manager Host service and its Web client.
 * Both halves import from this module; keep every field JSON-serializable.
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The request config failed validation. */
    'cap/invalid-config': {}
    /** A serverName or entry id collides with an existing row. */
    'cap/name-conflict': {}
    /** No matching row in the requested layer. */
    'cap/not-found': {}
    /** The target patch file is malformed; nothing was written. */
    'cap/yaml-invalid': {}
    /** The request named a project scope without a usable project root. */
    'cap/no-project': {}
    /** The target belongs to a read-only layer (preset row / provider skill). */
    'cap/readonly': {}
    /** A Claude Code plugin source download failed (M6). */
    'cap/cc-network': {}
    /** A Claude Code plugin payload is unusable (no manifest, bad paths) (M6). */
    'cap/cc-invalid-source': {}
  }
}

/** Where one MCP server row is persisted. */
export type McpScope = 'global' | 'profile' | 'preset' | 'project'

/** Connection state derived from the loader fiber and the tools registry. */
export type McpStatus = 'connected' | 'connecting' | 'failed' | 'stopped' | 'disabled'

/**
 * Server config as carried over the wire. Secret-looking `env`/`headers` keys
 * are masked to `null` by `list` (null = keep existing on write); `!!js`
 * expression values travel as `!!js <expr>` strings.
 */
export interface McpConfigView {
  readonly transport: 'stdio' | 'streamable-http'
  readonly serverName: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | null>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string | null>>
  readonly toolCallTimeoutMs?: number
  readonly failOnStartupError?: boolean
}

/** One MCP server row as shown in the manager list. */
export interface McpServerEntry {
  /** Composition entry id (`mcp-<serverName>`; project rows use `project/<name>`). */
  readonly id: string
  readonly serverName: string
  readonly scope: McpScope
  /** Transport kind, from the row config when readable. */
  readonly transport: 'stdio' | 'streamable-http' | 'unknown'
  /** One-line command or URL summary for the card description. */
  readonly summary: string
  readonly enabled: boolean
  readonly status: McpStatus
  /** Number of registered `mcp__<serverName>__*` tools. */
  readonly toolCount: number
  /** Failure detail from the fiber or the mounter, when present. */
  readonly error?: string
  /** The row's config with sensitive values masked; absent when unreadable. */
  readonly config?: McpConfigView
  /** Whether this plugin may edit, toggle, or remove the row. */
  readonly managed: boolean
}

/** Write-target scope for management operations. */
export type WriteScope = 'global' | 'profile' | 'project'

/** Reply of write operations: what landed and how it reaches the runtime. */
export interface ChangeOutcome {
  readonly applied: boolean
  /** Whether the running composition picked the change up (HMR present). */
  readonly live: boolean
  readonly restartRequired?: boolean
  readonly warnings?: readonly string[]
}

/** Reply of `capabilityManager/clearTrash`. */
export interface ClearTrashResult extends ChangeOutcome {
  /** How many trash items were destroyed. */
  readonly count: number
}

/** Request of `capabilityManager/writeMcp`. */
export interface WriteMcpRequest {
  readonly scope: WriteScope
  /** Canonical project root; required for the `project` scope. */
  readonly projectRoot?: string
  readonly config: McpConfigView
  readonly enabled: boolean
}

/** Request of `capabilityManager/removeMcp` and `setMcpEnabled` (enabled only for the latter). */
export interface McpRowRequest {
  readonly scope: WriteScope
  readonly projectRoot?: string
  readonly serverName: string
  readonly enabled?: boolean
}

/** Request of `capabilityManager/testMcp`. */
export interface TestMcpRequest {
  readonly config: McpConfigView
  readonly timeoutMs?: number
}

/** Reply of `capabilityManager/testMcp`. */
export interface TestMcpResult {
  readonly ok: boolean
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly toolNames?: readonly string[]
  readonly error?: string
  readonly durationMs: number
}

/** Request of `capabilityManager/list`. */
export interface ListRequest {
  /** Project root whose `.dsh/mcp.yml` joins the reply; omit for the global view. */
  readonly projectRoot?: string
}

/** One project offered by the picker. */
export interface ProjectInfo {
  /** Canonical project root (pass back as `projectRoot`). */
  readonly root: string
  readonly title: string
  /** Live sessions whose project root resolves here. */
  readonly liveSessions: number
  /** Whether `<root>/.dsh/mcp.yml` exists. */
  readonly hasConfig: boolean
}

/** Reply of `capabilityManager/setActiveProject`. */
export interface SetActiveProjectRequest {
  /** Project root to keep mounted for inspection; omit/undefined releases the lock. */
  readonly root?: string
}

/** Project-level facts of one `list` reply. */
export interface ProjectSummary {
  readonly root: string
  readonly title: string
  /** Whether the mounter currently holds fibers for this root. */
  readonly active: boolean
  /** File-level parse error, when the project file exists but is unreadable. */
  readonly fileError?: string
}

/** One skill as shown in the manager list. */
export interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** Provider source label: project-dsh / project-agents / user-dsh / user-agents / bundled / … */
  readonly source: string
  readonly scope: 'project' | 'user' | 'plugin'
  /** Absolute instruction file, when the provider reports one. */
  readonly path?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Whether this plugin can edit/delete the backing file. */
  readonly writable: boolean
  /** A higher-precedence entry with the same name wins the catalog. */
  readonly shadowed?: boolean
  /** The winning entry's file path, when shadowed. */
  readonly shadowedBy?: string
  /** Why this entry could not be parsed as a skill. */
  readonly error?: string
}

/** Request of `capabilityManager/writeSkill`. */
export interface WriteSkillRequest {
  /** Target root bucket; project buckets require `projectRoot`. */
  readonly scopeDir: 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'
  readonly projectRoot?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** Markdown body below the frontmatter. */
  readonly body: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Request of `capabilityManager/setSkillFlags`. */
export interface SetSkillFlagsRequest {
  readonly path: string
  readonly modelInvocable?: boolean
  readonly userInvocable?: boolean
}

/** Request of `capabilityManager/removeSkill`. */
export interface RemoveSkillRequest {
  readonly path: string
}

/** Request of `capabilityManager/readSkill`. */
export interface ReadSkillRequest {
  readonly path: string
}

/** Reply of `capabilityManager/readSkill`. */
export interface ReadSkillResult {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly body: string
  readonly file: string
}

/** Reply of `capabilityManager/list`. */
export interface CapabilityListResult {
  readonly profileName: string
  readonly mcp: readonly McpServerEntry[]
  readonly skills: readonly SkillEntry[]
  /** Present when the request named a project root. */
  readonly project?: ProjectSummary
}

// ---- import / export / trash (DESIGN.md §7, §10) ----

/** One `${input:…}` placeholder an import's apply step must fill. */
export interface ImportInput {
  readonly id: string
  readonly description?: string
  /** Render the wizard field as a password input. */
  readonly password?: boolean
}

/** One converted server of a parsed mcpServers document. */
export interface ImportPreviewEntry {
  /** Final server name (slugged when the source key was invalid). */
  readonly name: string
  readonly originalName: string
  /** The source key needed auto-renaming. */
  readonly renamed?: boolean
  readonly transport: 'stdio' | 'streamable-http'
  /** Wire config; env references already carry `!!js ` expressions. */
  readonly config: McpConfigView
  readonly warnings: readonly string[]
  /** Placeholders referenced by this entry's values. */
  readonly inputs: readonly ImportInput[]
}

/** Reply of `capabilityManager/previewMcpImport`. */
export interface ImportPreview {
  readonly entries: readonly ImportPreviewEntry[]
  /** Source entries that could not be converted, with reasons. */
  readonly errors: readonly string[]
}

/** Reply of `capabilityManager/exportMcp`. */
export interface ExportMcpResult {
  /** A standard `{"mcpServers": …}` document ready to download. */
  readonly json: string
  /** Rows left out (disabled ones — the format has no disabled flag). */
  readonly skipped: number
}

/** One file of an archive-style transfer (path is relative, POSIX separators). */
export interface ImportFilePayload {
  readonly path: string
  readonly base64: string
}

/** Request of `capabilityManager/importSkills`. */
export interface ImportSkillsRequest {
  readonly scopeDir: WriteSkillRequest['scopeDir']
  readonly projectRoot?: string
  readonly files: readonly ImportFilePayload[]
  /** Replace existing skills with the same name; false skips them. */
  readonly overwrite: boolean
}

/** Reply of `capabilityManager/importSkills`. */
export interface ImportSkillsResult {
  readonly imported: readonly { readonly name: string; readonly file: string }[]
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

/** Reply of `capabilityManager/readSkillBundleRpc`. */
export interface SkillBundle {
  readonly name: string
  /** Paths relative to the skill directory (or its single file's name). */
  readonly files: readonly ImportFilePayload[]
}

/** One trash item under the plugin trash root. */
export interface TrashEntry {
  /** Trash directory entry name; pass back as `id`. */
  readonly id: string
  readonly name: string
  readonly kind: 'skill-dir' | 'skill-file' | 'unknown'
  /** Absolute path of the trash item. */
  readonly path: string
  /** Where restore puts it back; legacy items may not know. */
  readonly originalPath?: string
  readonly trashedAt?: string
}

/** One `.cap-bak-*` copy beside a managed file. */
export interface BackupEntry {
  /** The backup file (absolute); pass back to restore/delete. */
  readonly file: string
  /** The managed file it restores onto. */
  readonly target: string
  readonly time?: string
  readonly size: number
}

/** Live status of one MCP server an installed plugin mounted. */
export interface CcServerStatus {
  readonly status: McpStatus
  readonly toolCount: number
  readonly error?: string
}

/** Installed overlay merged into one marketplace entry (M6). */
export interface CcInstalledView {
  readonly version: string
  readonly enabled: boolean
  readonly skills: number
  readonly servers: Readonly<Record<string, CcServerStatus>>
  /** Content dsh does not consume (commands / agents / hooks), kept honest. */
  readonly skippedContent: readonly string[]
  readonly updatedAt: string
  readonly updateAvailable: boolean
}

/** One Claude Code marketplace entry as the panel sees it (M6). */
export interface CcMarketEntryView {
  readonly name: string
  readonly description?: string
  readonly author?: string
  readonly category?: string
  readonly homepage?: string
  readonly installed?: CcInstalledView
}

/** Reply of `capabilityManager/listCcPlugins` (M6). */
export interface CcPluginsListResult {
  readonly marketName: string
  readonly fetchedAt: string
  readonly entries: readonly CcMarketEntryView[]
}

/** Reply of install/update (M6). */
export interface CcInstallResult {
  readonly name: string
  readonly version: string
  readonly skills: readonly string[]
  readonly servers: readonly string[]
  readonly warnings: readonly string[]
  readonly skippedContent: readonly string[]
  /** Update only: the download was byte-identical; just the pin moved. */
  readonly unchanged?: boolean
  readonly applied: boolean
  readonly live: boolean
}

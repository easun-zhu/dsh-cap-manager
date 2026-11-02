/**
 * Structural views of the client services this panel uses. The dsh-client
 * packages ship only with the Web app; a third-party bundle reaches them
 * through the Cordis context, so these local shapes keep the panel typed
 * without installing those packages.
 */

import type {
  BackupEntry, CapabilityListResult, CcInstallResult, CcPluginsListResult, ChangeOutcome, ClearTrashResult, ExportMcpResult,
  ImportPreview, ImportSkillsRequest, ImportSkillsResult, ListRequest, McpRowRequest, ProjectInfo, ReadSkillResult,
  SetActiveProjectRequest, SkillBundle, TestMcpRequest, TestMcpResult, TrashEntry, WriteMcpRequest, WriteSkillRequest,
} from '../types.ts'

/** Locale translate function bound to one namespace. */
export interface Translate {
  (key: string, params?: Record<string, unknown>): string
}

/** Reversible registration handle as yielded inside `slots.inject` callbacks. */
export interface Disposable {
  (): void
}

/** The browser slot registry (`ctx.slots`). */
export interface SlotsLike {
  inject(slot: string, register: () => Disposable | Iterator<Disposable>): Disposable
  register(options: Record<string, unknown>, component: (props: never) => unknown): Disposable
}

/** The browser locale service (`ctx.locale`). */
export interface LocaleLike {
  register(ns: string, locale: string, dict: Record<string, string>): Disposable
  bind(ns: string): Translate
}

/** Successful Remote call outcome. */
export interface RemoteOk<T> { readonly ok: true; readonly value: T }
/** Failed Remote call outcome. */
export interface RemoteErr { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export type RemoteResultLike<T> = RemoteOk<T> | RemoteErr

/** The `capabilityManager` namespace this plugin mounts on the client. */
export interface CapabilityManagerRemote {
  list(request?: ListRequest): Promise<RemoteResultLike<CapabilityListResult>>
  listProjects(): Promise<RemoteResultLike<readonly ProjectInfo[]>>
  setActiveProject(request: SetActiveProjectRequest): Promise<RemoteResultLike<void>>
  writeMcp(request: WriteMcpRequest): Promise<RemoteResultLike<ChangeOutcome>>
  removeMcp(request: McpRowRequest): Promise<RemoteResultLike<ChangeOutcome>>
  setMcpEnabled(request: McpRowRequest): Promise<RemoteResultLike<ChangeOutcome>>
  testMcp(request: TestMcpRequest): Promise<RemoteResultLike<TestMcpResult>>
  writeSkill(request: WriteSkillRequest): Promise<RemoteResultLike<ChangeOutcome>>
  setSkillFlagsRpc(request: { path: string; modelInvocable?: boolean; userInvocable?: boolean }): Promise<RemoteResultLike<ChangeOutcome>>
  removeSkillRpc(request: { path: string }): Promise<RemoteResultLike<ChangeOutcome>>
  readSkillRpc(request: { path: string }): Promise<RemoteResultLike<ReadSkillResult>>
  previewMcpImport(request: { json: string }): Promise<RemoteResultLike<ImportPreview>>
  exportMcp(request?: { projectRoot?: string, serverName?: string }): Promise<RemoteResultLike<ExportMcpResult>>
  importSkills(request: ImportSkillsRequest): Promise<RemoteResultLike<ImportSkillsResult>>
  readSkillBundleRpc(request: { path: string }): Promise<RemoteResultLike<SkillBundle>>
  listTrash(): Promise<RemoteResultLike<readonly TrashEntry[]>>
  restoreTrash(request: { id: string }): Promise<RemoteResultLike<ChangeOutcome>>
  deleteTrash(request: { id: string }): Promise<RemoteResultLike<ChangeOutcome>>
  clearTrash(): Promise<RemoteResultLike<ClearTrashResult>>
  listBackups(): Promise<RemoteResultLike<readonly BackupEntry[]>>
  restoreBackup(request: { file: string }): Promise<RemoteResultLike<ChangeOutcome>>
  deleteBackup(request: { file: string }): Promise<RemoteResultLike<void>>
  listCcPlugins(request?: { refresh?: boolean }): Promise<RemoteResultLike<CcPluginsListResult>>
  installCcPlugin(request: { name: string }): Promise<RemoteResultLike<CcInstallResult>>
  updateCcPlugin(request: { name: string }): Promise<RemoteResultLike<CcInstallResult & { upToDate: boolean }>>
  uninstallCcPlugin(request: { name: string }): Promise<RemoteResultLike<ChangeOutcome>>
  setCcPluginEnabled(request: { name: string; enabled: boolean }): Promise<RemoteResultLike<ChangeOutcome>>
}

/** Unwrap one Remote result or throw the wire failure as an Error. */
export async function unwrap<T>(call: Promise<RemoteResultLike<T>>): Promise<T> {
  const result = await call
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/** Hand-written Remote contribution (TypertRemoteContribution shape). */
export interface RemoteContribution {
  readonly package: string
  readonly descriptors: readonly object[]
}

/** The browser Remote facade (`ctx.remote`). */
export interface RemoteLike {
  $mount(contribution: RemoteContribution): Promise<() => Promise<void>>
  capabilityManager: CapabilityManagerRemote
}

/** The browser access gate (`ctx.remoteAccess`). */
export interface RemoteAccessLike {
  whenAccess(action: string, install: () => Iterator<Disposable>): Disposable
}

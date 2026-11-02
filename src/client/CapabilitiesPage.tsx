/**
 * The MCP & Skills main panel: scope-grouped card lists with live status, and
 * the MCP editor (add/edit) opened from a card or the toolbar. A project
 * selector in the toolbar pins one project — its `.dsh/mcp.yml` servers join
 * the list and stay mounted for inspection — while every write action lands
 * through `capabilityManager` and refreshes the list after the Host settles.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  BackupEntry, CapabilityListResult, CcInstallResult, CcPluginsListResult, ChangeOutcome, ExportMcpResult,
  ImportPreview, ImportSkillsRequest, ImportSkillsResult, McpConfigView, McpServerEntry, ProjectInfo,
  ReadSkillResult, SkillEntry, TrashEntry, WriteSkillRequest, WriteScope,
} from '../types.ts'
import { ImportWizard } from './ImportWizard.tsx'
import { McpEditor } from './McpEditor.tsx'
import { SkillEditor } from './SkillEditor.tsx'
import { SkillImport } from './SkillImport.tsx'
import { TrashPanel } from './TrashPanel.tsx'
import { CcPluginsPanel } from './CcPluginsPanel.tsx'
import { downloadText } from './files.ts'
import { injectStyles } from './styles.ts'
import type { Translate } from './shims.ts'

export type CapabilitiesLoadOutcome = {
  readonly kind: 'loaded'
  readonly value: CapabilityListResult
} | {
  readonly kind: 'error'
  readonly message: string
}

export interface CapabilitiesActions {
  listProjects(): Promise<readonly ProjectInfo[]>
  /** Pin (undefined releases) the project whose servers stay mounted for the panel. */
  setActiveProject(root: string | undefined): Promise<void>
  setEnabled(scope: WriteScope, serverName: string, enabled: boolean, projectRoot?: string): Promise<ChangeOutcome>
  write(scope: WriteScope, config: McpConfigView, enabled: boolean, projectRoot?: string): Promise<ChangeOutcome>
  remove(scope: WriteScope, serverName: string, projectRoot?: string): Promise<ChangeOutcome>
  test(config: McpConfigView): Promise<TestOutcome>
  writeSkill(request: WriteSkillRequest): Promise<ChangeOutcome>
  setSkillFlags(path: string, flags: { modelInvocable?: boolean; userInvocable?: boolean }): Promise<ChangeOutcome>
  removeSkill(path: string): Promise<ChangeOutcome>
  readSkill(path: string): Promise<ReadSkillResult>
  /** Parse one mcpServers document into converted entries (preview only). */
  previewImport(json: string): Promise<ImportPreview>
  /** Merge every managed row (plus one project) into a standard document; `serverName` exports that one row. */
  exportMcp(projectRoot?: string, serverName?: string): Promise<ExportMcpResult>
  /** Import an extracted archive/folder listing into one skill bucket. */
  importSkills(request: ImportSkillsRequest): Promise<ImportSkillsResult>
  /** Download one skill as .md (file skills) or .zip (directory skills). */
  exportSkill(path: string): Promise<void>
  listTrash(): Promise<readonly TrashEntry[]>
  restoreTrash(id: string): Promise<ChangeOutcome>
  deleteTrash(id: string): Promise<ChangeOutcome>
  /** Permanently destroy every trash item; the count comes back in the reply. */
  clearTrash(): Promise<ChangeOutcome & { count: number }>
  listBackups(): Promise<readonly BackupEntry[]>
  restoreBackup(file: string): Promise<ChangeOutcome>
  deleteBackup(file: string): Promise<void>
  /** Marketplace listing merged with the installed overlay (M6). */
  listCcPlugins(refresh?: boolean): Promise<CcPluginsListResult>
  installCcPlugin(name: string): Promise<CcInstallResult>
  updateCcPlugin(name: string): Promise<CcInstallResult & { upToDate: boolean }>
  uninstallCcPlugin(name: string): Promise<ChangeOutcome>
  setCcPluginEnabled(name: string, enabled: boolean): Promise<ChangeOutcome>
}

export interface TestOutcome {
  readonly ok: boolean
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly toolNames?: readonly string[]
  readonly error?: string
  readonly durationMs: number
}

export interface CapabilitiesPageProps {
  readonly t: Translate
  readonly load: (request?: { projectRoot?: string }) => Promise<CapabilitiesLoadOutcome>
  readonly actions: CapabilitiesActions
}

type Tab = 'mcp' | 'skills' | 'cc'
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'edit'; readonly entry: McpServerEntry | undefined; readonly prefill?: McpConfigView }
  | { readonly kind: 'skill-edit'; readonly entry: SkillEntry | undefined }
  | { readonly kind: 'import' }
  | { readonly kind: 'skill-import' }
  | { readonly kind: 'trash' }

type PanelState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'loaded'; readonly value: CapabilityListResult }
  | { readonly phase: 'error'; readonly message: string }

interface Group<T> {
  readonly key: string
  readonly label: string
  readonly rows: readonly T[]
}

export function CapabilitiesPage({ t, load, actions }: CapabilitiesPageProps): ReactNode {
  injectStyles()
  const [tab, setTab] = useState<Tab>('mcp')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<PanelState>({ phase: 'loading' })
  const [view, setView] = useState<View>({ kind: 'list' })
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [projects, setProjects] = useState<readonly ProjectInfo[]>([])
  const [root, setRoot] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    setState({ phase: 'loading' })
    void load(root === undefined ? undefined : { projectRoot: root }).then(outcome => {
      setState(outcome.kind === 'loaded'
        ? { phase: 'loaded', value: outcome.value }
        : { phase: 'error', message: outcome.message })
    }, (error: unknown) => {
      setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }, [load, root])

  useEffect(() => { refresh() }, [refresh])

  // One-shot project inventory; the most recently used project preselects itself.
  useEffect(() => {
    void actions.listProjects().then(list => {
      setProjects(list)
      const preferred = list.find(project => project.liveSessions > 0 && project.hasConfig)
        ?? list.find(project => project.liveSessions > 0)
      if (preferred !== undefined) selectProject(preferred.root)
    }).catch(() => { setProjects([]) })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time inventory only
  }, [])

  const selectProject = (next: string | undefined): void => {
    setRoot(next)
    void actions.setActiveProject(next).catch(() => undefined)
  }

  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { setNotice(undefined) }, 5000)
    return () => { clearTimeout(timer) }
  }, [notice])

  /** Await one write action, toast its outcome, and refresh as HMR settles and the fiber re-mounts. */
  const runAction = useCallback(async (action: () => Promise<ChangeOutcome>, success: string): Promise<boolean> => {
    try {
      const outcome = await action()
      setNotice(outcome.live ? success : `${success} · ${t('appliedRestart')}`)
      for (const delay of [500, 1500, 3000]) setTimeout(() => { refresh() }, delay)
      return true
    } catch (error) {
      setNotice(`${t('actionFailed')}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }, [refresh, t])

  /** Download the standard mcpServers document (project rows merge in when one is selected). */
  const exportAll = useCallback((): void => {
    void actions.exportMcp(root).then(result => {
      const stamp = new Date().toISOString().slice(0, 10)
      downloadText(`mcp-servers-${stamp}.json`, result.json, 'application/json')
      setNotice(result.skipped > 0 ? t('exportSkipped', { count: String(result.skipped) }) : t('exportDone'))
    }, (error: unknown) => {
      setNotice(`${t('actionFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [actions, root, t])

  /** Toast an import/export side-effect and refresh as watchers settle. */
  const sideNotice = useCallback((notice: string): void => {
    setNotice(notice)
    for (const delay of [500, 1500, 3000]) setTimeout(() => { refresh() }, delay)
  }, [refresh])

  const needle = query.trim().toLowerCase()
  const mcp = state.phase === 'loaded'
    ? state.value.mcp.filter(row => needle === '' || row.serverName.toLowerCase().includes(needle))
    : []
  const skills = state.phase === 'loaded'
    ? state.value.skills.filter(row => needle === '' || row.name.toLowerCase().includes(needle)
      || row.description.toLowerCase().includes(needle))
    : []
  const profileName = state.phase === 'loaded' ? state.value.profileName : ''
  const project = state.phase === 'loaded' ? state.value.project : undefined
  const projectRoot = project?.root
  const projectTitle = project?.title ?? ''

  if (view.kind === 'edit') {
    return (
      <div className="cap-page">
        <McpEditor
          t={t}
          entry={view.entry}
          prefill={view.prefill}
          profileName={profileName}
          projectRoot={projectRoot}
          projectTitle={projectTitle}
          actions={actions}
          onClose={() => { setView({ kind: 'list' }) }}
          onSaved={outcome => {
            setView({ kind: 'list' })
            void runAction(async () => outcome, t('saved'))
          }}
          onRemoved={outcome => {
            setView({ kind: 'list' })
            void runAction(async () => outcome, t('removed'))
          }}
          onError={message => { setNotice(`${t('actionFailed')}: ${message}`) }}
        />
        {notice === undefined ? undefined : <div className="cap-notice" role="status">{notice}</div>}
      </div>
    )
  }

  if (view.kind === 'skill-edit') {
    return (
      <div className="cap-page">
        <SkillEditor
          t={t}
          entry={view.entry}
          projectRoot={projectRoot}
          actions={actions}
          onClose={() => { setView({ kind: 'list' }) }}
          onSaved={outcome => {
            setView({ kind: 'list' })
            void runAction(async () => outcome, t('skillSaved'))
          }}
          onRemoved={outcome => {
            setView({ kind: 'list' })
            void runAction(async () => outcome, t('skillRemoved'))
          }}
          onError={message => { setNotice(`${t('actionFailed')}: ${message}`) }}
        />
        {notice === undefined ? undefined : <div className="cap-notice" role="status">{notice}</div>}
      </div>
    )
  }

  if (view.kind === 'import') {
    return (
      <div className="cap-page">
        <ImportWizard
          t={t}
          profileName={profileName}
          projectRoot={projectRoot}
          projectTitle={projectTitle}
          actions={actions}
          onClose={() => { setView({ kind: 'list' }) }}
          onApplied={sideNotice}
        />
        {notice === undefined ? undefined : <div className="cap-notice" role="status">{notice}</div>}
      </div>
    )
  }

  if (view.kind === 'skill-import') {
    return (
      <div className="cap-page">
        <SkillImport
          t={t}
          projectRoot={projectRoot}
          actions={actions}
          onClose={() => { setView({ kind: 'list' }) }}
          onImported={sideNotice}
        />
        {notice === undefined ? undefined : <div className="cap-notice" role="status">{notice}</div>}
      </div>
    )
  }

  if (view.kind === 'trash') {
    return (
      <div className="cap-page">
        <TrashPanel
          t={t}
          actions={actions}
          onClose={() => { setView({ kind: 'list' }) }}
          onChanged={refresh}
        />
        {notice === undefined ? undefined : <div className="cap-notice" role="status">{notice}</div>}
      </div>
    )
  }

  return (
    <div className="cap-page">
      <div className="cap-toolbar">
        <div className="cap-tabs" role="tablist">
          <button type="button" role="tab" className="cap-tab" aria-selected={tab === 'mcp'} onClick={() => { setTab('mcp') }}>{t('tabMcp')}</button>
          <button type="button" role="tab" className="cap-tab" aria-selected={tab === 'skills'} onClick={() => { setTab('skills') }}>{t('tabSkills')}</button>
          <button type="button" role="tab" className="cap-tab" aria-selected={tab === 'cc'} onClick={() => { setTab('cc') }}>{t('tabCc')}</button>
        </div>
        <label className="cap-project-select">
          <span className="cap-sr-only">{t('projectSelect')}</span>
          <select
            value={root ?? ''}
            onChange={event => { selectProject(event.currentTarget.value === '' ? undefined : event.currentTarget.value) }}
          >
            <option value="">{t('projectNone')}</option>
            {projects.map(project => (
              <option key={project.root} value={project.root}>
                {project.liveSessions > 0 ? `● ${project.title}` : project.hasConfig ? `· ${project.title}` : project.title}
                {project.liveSessions > 0 ? ` (${project.liveSessions})` : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="cap-spacer" />
        {tab === 'cc' ? undefined : (
          <div className="cap-search">
            <input type="search" placeholder={t('searchPlaceholder')} value={query}
              onChange={event => { setQuery(event.currentTarget.value) }} aria-label={t('searchPlaceholder')} />
          </div>
        )}
        {tab === 'mcp' ? (
          <>
            <button type="button" className="cap-button cap-primary" onClick={() => { setView({ kind: 'edit', entry: undefined }) }}>+ {t('addServer')}</button>
            <button type="button" className="cap-button" onClick={() => { setView({ kind: 'import' }) }}>⇩ {t('importTitleShort')}</button>
            <button type="button" className="cap-button" onClick={exportAll}>⇧ {t('exportMcpButton')}</button>
          </>
        ) : tab === 'skills' ? (
          <>
            <button type="button" className="cap-button cap-primary" onClick={() => { setView({ kind: 'skill-edit', entry: undefined }) }}>+ {t('skillAdd')}</button>
            <button type="button" className="cap-button" onClick={() => { setView({ kind: 'skill-import' }) }}>⇩ {t('skillImportTitle')}</button>
          </>
        ) : undefined}
        <button type="button" className="cap-button" onClick={() => { setView({ kind: 'trash' }) }}>♻ {t('trashButton')}</button>
        <button type="button" className="cap-button" onClick={refresh}>{t('refresh')}</button>
      </div>
      {notice === undefined ? undefined : <div className="cap-notice" role="status">{notice}</div>}
      {project?.fileError === undefined ? undefined : (
        <div className="cap-notice cap-notice-error" role="alert">{t('projectFileError', { message: project.fileError })}</div>
      )}
      {project !== undefined && !project.active ? (
        <div className="cap-notice" role="status">{t('projectInactive', { name: project.title })}</div>
      ) : undefined}
      <div className="cap-body">
        {state.phase === 'loading' ? <div className="cap-message">…</div> : null}
        {state.phase === 'error' ? (
          <div className="cap-message">
            <p>{t('loadFailed', { message: state.message })}</p>
            <button type="button" className="cap-button" onClick={refresh}>{t('retry')}</button>
          </div>
        ) : null}
        {state.phase === 'loaded' ? (
          tab === 'mcp'
            ? <McpList t={t} rows={mcp} profileName={profileName} projectTitle={projectTitle} projectRoot={projectRoot} actions={actions} runAction={runAction} onNotice={setNotice} onOpen={entry => { setView({ kind: 'edit', entry }) }} />
            : tab === 'skills'
              ? <SkillList t={t} rows={skills} actions={actions} runAction={runAction} onNotice={setNotice} onOpen={entry => { setView({ kind: 'skill-edit', entry }) }} />
              : <CcPluginsPanel t={t} actions={actions} onNotice={setNotice} onSkillsChanged={() => { for (const delay of [500, 1500, 3000]) setTimeout(() => { refresh() }, delay) }} />
        ) : null}
      </div>
    </div>
  )
}

type RunAction = (action: () => Promise<ChangeOutcome>, success: string) => Promise<boolean>

function McpList({ t, rows, profileName, projectTitle, projectRoot, actions, runAction, onNotice, onOpen }: {
  t: Translate
  rows: readonly McpServerEntry[]
  profileName: string
  projectTitle: string
  projectRoot: string | undefined
  actions: CapabilitiesActions
  runAction: RunAction
  onNotice(message: string): void
  onOpen(entry: McpServerEntry): void
}): ReactNode {
  if (rows.length === 0) return <div className="cap-empty">{t('emptyMcp')}</div>
  const groups: readonly Group<McpServerEntry>[] = [
    ...(projectRoot === undefined ? [] : [{
      key: 'project',
      label: t('groupProject', { name: projectTitle }),
      rows: rows.filter(row => row.scope === 'project'),
    }]),
    { key: 'global', label: t('groupGlobal'), rows: rows.filter(row => row.scope === 'global') },
    { key: 'profile', label: t('groupProfile', { name: profileName }), rows: rows.filter(row => row.scope === 'profile') },
    { key: 'preset', label: t('groupPreset'), rows: rows.filter(row => row.scope === 'preset') },
  ]
  return <>{groups.filter(group => group.rows.length > 0).map(group => (
    <section key={group.key} className="cap-group">
      <h3 className="cap-group-head">{group.label} <span className="cap-group-count">{group.rows.length}</span></h3>
      <ul className="cap-cards">
        {group.rows.map(row => (
          <McpCard
            key={row.id}
            t={t}
            row={row}
            projectRoot={row.scope === 'project' ? projectRoot : undefined}
            actions={actions}
            runAction={runAction}
            onNotice={onNotice}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  ))}</>
}

function McpCard({ t, row, projectRoot, actions, runAction, onNotice, onOpen }: {
  t: Translate
  row: McpServerEntry
  projectRoot: string | undefined
  actions: CapabilitiesActions
  runAction: RunAction
  onNotice(message: string): void
  onOpen(entry: McpServerEntry): void
}): ReactNode {
  const statusTone = row.status === 'connected' ? 'success'
    : row.status === 'connecting' ? 'info'
      : row.status === 'failed' ? 'danger' : 'neutral'
  const statusText = row.status === 'connected'
    ? row.toolCount === undefined ? t('statusConnected')
      : `${t('statusConnected')} · ${t('toolsCount', { count: String(row.toolCount) })}`
    : row.status === 'stopped' && row.scope === 'project' ? t('statusNotMounted')
      : t(`status${capitalize(row.status)}`)
  return (
    <li className="cap-card" data-cap-status={row.enabled === false ? 'stopped' : row.status}>
      <div className="cap-cardHead">
        <span className="cap-cardIcon" aria-hidden="true"><TransportGlyph transport={row.transport} /></span>
        <div className="cap-cardMain">
          <div className="cap-titleRow">
            {row.managed ? (
              <button type="button" className="cap-cardTitle cap-cardOpen" aria-label={t('openDetail', { name: row.serverName })} onClick={() => { onOpen(row) }}>{row.serverName}</button>
            ) : (
              <span className="cap-cardTitle">{row.serverName}</span>
            )}
            <Tag tone="quiet">{t(`scope${capitalize(row.scope)}`)}</Tag>
            <Tag tone="quiet">{row.transport === 'unknown' ? '?' : row.transport}</Tag>
            <Tag tone={statusTone}>
              <span className="cap-dot" data-state={row.status} />{statusText}
            </Tag>
          </div>
          <span className="cap-cardDesc">{row.summary}</span>
        </div>
      </div>
      {row.error === undefined ? undefined : <p className="cap-error-text" role="status">{row.error}</p>}
      {row.managed ? (
        <div className="cap-cardFoot">
          <Switch
            checked={row.enabled}
            onChange={next => {
              void runAction(
                () => actions.setEnabled(row.scope === 'project' ? 'project' : row.scope as WriteScope, row.serverName, next, projectRoot),
                next ? t('enabledNotice', { name: row.serverName }) : t('disabledNotice', { name: row.serverName }),
              )
            }}
            label={t('toggleEnable', { name: row.serverName })}
          />
          <div className="cap-cardEnd">
            <button type="button" className="cap-button" onClick={() => { onOpen(row) }}>{t('edit')}</button>
            <button type="button" className="cap-button" aria-label={t('exportMcpButton')}
              onClick={() => {
                void actions.exportMcp(projectRoot, row.serverName).then(result => {
                  downloadText(`mcp-server-${row.serverName}.json`, result.json, 'application/json')
                  onNotice(t('exportDone'))
                }, (error: unknown) => {
                  onNotice(`${t('actionFailed')}: ${error instanceof Error ? error.message : String(error)}`)
                })
              }}>⇧ {t('exportMcpButton')}</button>
            <button type="button" className="cap-button cap-danger"
              onClick={() => {
                if (!window.confirm(t('confirmRemove', { name: row.serverName }))) return
                void runAction(
                  () => actions.remove(row.scope === 'project' ? 'project' : row.scope as WriteScope, row.serverName, projectRoot),
                  t('removed'),
                )
              }}>{t('removeServer')}</button>
          </div>
        </div>
      ) : undefined}
    </li>
  )
}

function SkillList({ t, rows, actions, runAction, onNotice, onOpen }: {
  t: Translate
  rows: readonly SkillEntry[]
  actions: CapabilitiesActions
  runAction: RunAction
  onNotice(message: string): void
  onOpen(entry: SkillEntry): void
}): ReactNode {
  if (rows.length === 0) return <div className="cap-empty">{t('emptySkills')}</div>
  const groups: readonly Group<SkillEntry>[] = [
    { key: 'project', label: t('skillSourceProject'), rows: rows.filter(row => row.scope === 'project') },
    { key: 'user', label: t('skillSourceUser'), rows: rows.filter(row => row.scope === 'user') },
    { key: 'plugin', label: t('groupPreset'), rows: rows.filter(row => row.scope === 'plugin') },
  ]
  return <>{groups.filter(group => group.rows.length > 0).map(group => (
    <section key={group.key} className="cap-group">
      <h3 className="cap-group-head">{group.label} <span className="cap-group-count">{group.rows.length}</span></h3>
      <ul className="cap-cards">
        {group.rows.map(row => (
          <SkillCard key={row.path ?? `${row.source}:${row.name}`} t={t} row={row} actions={actions} runAction={runAction} onNotice={onNotice} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  ))}</>
}

function SkillCard({ t, row, actions, runAction, onNotice, onOpen }: {
  t: Translate
  row: SkillEntry
  actions: CapabilitiesActions
  runAction: RunAction
  onNotice(message: string): void
  onOpen(entry: SkillEntry): void
}): ReactNode {
  const broken = row.error !== undefined
  const editable = row.writable && !broken && row.path !== undefined
  const removable = row.writable && row.path !== undefined
  const off = !row.modelInvocable && !row.userInvocable
  return (
    <li className="cap-card" data-cap-status={broken ? 'failed' : off ? 'stopped' : row.shadowed === true ? 'stopped' : 'connected'}>
      <div className="cap-cardHead">
        <span className="cap-cardIcon" aria-hidden="true"><SkillGlyph /></span>
        <div className="cap-cardMain">
          <div className="cap-titleRow">
            {editable ? (
              <button type="button" className="cap-cardTitle cap-cardOpen" aria-label={t('openDetail', { name: row.name })} onClick={() => { onOpen(row) }}>{row.name}</button>
            ) : (
              <span className="cap-cardTitle">{row.name}</span>
            )}
            <Tag tone="quiet">{t(`skillSource${capitalize(row.scope)}`)}</Tag>
            {row.shadowed === true ? <Tag tone="warning">{t('shadowedBadge')}</Tag> : null}
            {broken ? <Tag tone="danger">{t('skillBroken')}</Tag> : null}
            {!row.writable && !broken ? (
              // One merged state tag; the rare hand-edited mixed state keeps both detail tags.
              row.modelInvocable === row.userInvocable
                ? row.modelInvocable ? null : <Tag tone="neutral">{t('statusDisabled')}</Tag>
                : (
                  <>
                    <Tag tone={row.modelInvocable ? 'success' : 'neutral'}>{t(row.modelInvocable ? 'skillModelOn' : 'skillModelOff')}</Tag>
                    <Tag tone={row.userInvocable ? 'quiet' : 'outline'}>{t(row.userInvocable ? 'skillUserOn' : 'skillUserOff')}</Tag>
                  </>
                )
            ) : null}
          </div>
          <span className="cap-cardDesc">{broken ? row.path : row.description}</span>
        </div>
      </div>
      {row.error === undefined ? undefined : <p className="cap-error-text" role="status">{row.error}</p>}
      {editable || removable ? (
        <div className="cap-cardFoot">
          {editable ? (
            <Switch
              checked={row.modelInvocable || row.userInvocable}
              onChange={next => {
                void runAction(
                  () => actions.setSkillFlags(row.path as string, { modelInvocable: next, userInvocable: next }),
                  next ? t('skillEnabledNotice', { name: row.name }) : t('skillDisabledNotice', { name: row.name }),
                )
              }}
              label={t('toggleEnable', { name: row.name })}
            />
          ) : undefined}
          <div className="cap-cardEnd">
            {editable ? (
              <button type="button" className="cap-button" onClick={() => { onOpen(row) }}>{t('edit')}</button>
            ) : undefined}
            {editable ? (
              <button type="button" className="cap-button" aria-label={t('exportSkill')}
                onClick={() => {
                  void actions.exportSkill(row.path as string).then(() => {
                    onNotice(t('skillExportDone', { name: row.name }))
                  }, (error: unknown) => {
                    onNotice(`${t('actionFailed')}: ${error instanceof Error ? error.message : String(error)}`)
                  })
                }}>⇧ {t('exportSkill')}</button>
            ) : undefined}
            {removable ? (
              <button type="button" className="cap-button cap-danger" aria-label={t('removeSkill')}
                onClick={() => {
                  if (!window.confirm(t('confirmRemoveSkill', { name: row.name }))) return
                  void runAction(() => actions.removeSkill(row.path as string), t('skillRemoved'))
                }}>{t('removeSkill')}</button>
            ) : undefined}
          </div>
        </div>
      ) : !row.writable ? (
        <div className="cap-cardFoot"><span className="cap-cardFootNote">{t('readonlyRow')}</span></div>
      ) : undefined}
    </li>
  )
}

export function TransportGlyph({ transport }: { readonly transport: McpServerEntry['transport'] }): ReactNode {
  if (transport === 'streamable-http') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        <path d="M2.8 8a5.2 5.2 0 0 1 10.4 0M4.9 8a3.1 3.1 0 0 1 6.2 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 6.5h6M5 9.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function SkillGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2.2c.5 1.7 1.6 2.8 3.3 3.3-1.7.5-2.8 1.6-3.3 3.3-.5-1.7-1.6-2.8-3.3-3.3C6.4 5 7.5 3.9 8 2.2Z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M11 9.2c.3 1 .9 1.6 1.9 1.9-1 .3-1.6.9-1.9 1.9-.3-1-.9-1.6-1.9-1.9 1-.3 1.6-.9 1.9-1.9Z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

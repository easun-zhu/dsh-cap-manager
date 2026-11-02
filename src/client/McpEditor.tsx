/**
 * The MCP server editor: one form for adding and editing rows in the global
 * or profile layer, with in-place connection testing and removal. Secret
 * values masked by the Host render as placeholder rows whose empty value
 * means "keep the stored one".
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangeOutcome, McpConfigView, McpServerEntry, WriteScope } from '../types.ts'
import { catalogConfig, STARTERS } from './catalog.ts'
import type { CapabilitiesActions, TestOutcome } from './CapabilitiesPage.tsx'
import type { Translate } from './shims.ts'

interface KeyValueRow {
  readonly key: string
  readonly value: string
  /** The stored value is a masked secret; an empty field keeps it. */
  readonly masked: boolean
}

interface FormState {
  scope: WriteScope
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  cwd: string
  env: readonly KeyValueRow[]
  url: string
  headers: readonly KeyValueRow[]
  timeoutText: string
  failOnStartupError: boolean
  enabled: boolean
}

export interface McpEditorProps {
  readonly t: Translate
  /** The row being edited; undefined for a new server. */
  readonly entry: McpServerEntry | undefined
  /** Add-flow prefill (catalog install); ignored when editing an existing row. */
  readonly prefill?: McpConfigView
  readonly profileName: string
  /** Project root backing the `project` scope option, when a project is selected. */
  readonly projectRoot: string | undefined
  readonly projectTitle: string
  readonly actions: CapabilitiesActions
  readonly onClose: () => void
  readonly onSaved: (outcome: ChangeOutcome) => void
  readonly onRemoved: (outcome: ChangeOutcome) => void
  readonly onError: (message: string) => void
}

export function McpEditor({ t, entry, prefill, profileName, projectRoot, projectTitle, actions, onClose, onSaved, onRemoved, onError }: McpEditorProps): ReactNode {
  const [form, setForm] = useState<FormState>(() => initialForm(entry, projectRoot, prefill))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestOutcome | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const patch = (changes: Partial<FormState>): void => {
    setForm(current => ({ ...current, ...changes }))
  }

  const buildConfig = (): McpConfigView => ({
    transport: form.transport,
    serverName: form.serverName.trim(),
    ...(form.transport === 'stdio' ? {
      command: form.command.trim(),
      args: form.argsText.split('\n').map(line => line.trim()).filter(line => line !== ''),
      ...(form.cwd.trim() === '' ? {} : { cwd: form.cwd.trim() }),
      env: recordOf(form.env),
    } : {
      url: form.url.trim(),
      headers: recordOf(form.headers),
    }),
    ...(form.timeoutText.trim() === '' ? {} : { toolCallTimeoutMs: Number(form.timeoutText.trim()) }),
    failOnStartupError: form.failOnStartupError,
  })

  const save = (): void => {
    setSaving(true)
    void actions.write(form.scope, buildConfig(), form.enabled, form.scope === 'project' ? projectRoot : undefined).then(outcome => {
      onSaved(outcome)
    }, (error: unknown) => {
      setSaving(false)
      onError(error instanceof Error ? error.message : String(error))
    })
  }

  const remove = (): void => {
    if (entry === undefined || !window.confirm(t('confirmRemove', { name: entry.serverName }))) return
    setSaving(true)
    void actions.remove(form.scope, entry.serverName, form.scope === 'project' ? projectRoot : undefined).then(outcome => {
      onRemoved(outcome)
    }, (error: unknown) => {
      setSaving(false)
      onError(error instanceof Error ? error.message : String(error))
    })
  }

  const test = (): void => {
    setTesting(true)
    setTestResult(undefined)
    void actions.test(buildConfig()).then(outcome => {
      setTesting(false)
      setTestResult(outcome)
    }, (error: unknown) => {
      setTesting(false)
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error), durationMs: 0 })
    })
  }

  return (
    <div className="cap-editor">
      <div className="cap-editor-top">
        <button type="button" className="cap-crumb" onClick={onClose}>‹ {t('tabMcp')}</button>
        <span className="cap-spacer" />
        {entry === undefined ? undefined : (
          <button type="button" className="cap-button cap-danger" disabled={saving} onClick={remove}>{t('removeServer')}</button>
        )}
      </div>
      <h2 className="cap-editor-title">
        {entry === undefined ? t('addServer') : t('editServer', { name: entry.serverName })}
      </h2>

      <div className="cap-form">
       <div className="cap-fieldset">
        {entry === undefined ? (
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('fieldTemplate')}</span>
            <span className="cap-fieldControl">
              <select value="" aria-label={t('fieldTemplate')}
                onChange={event => {
                  const template = STARTERS.find(item => item.key === event.currentTarget.value)
                  if (template === undefined) return
                  const config = catalogConfig(template)
                  patch({
                    transport: config.transport,
                    ...(form.serverName.trim() === '' ? { serverName: config.serverName } : {}),
                    command: config.command ?? '',
                    argsText: (config.args ?? []).join('\n'),
                    env: Object.entries(config.env ?? {}).map(([key, value]) => ({ key, value: value ?? '', masked: false })),
                    url: config.url ?? '',
                  })
                }}>
                <option value="">{t('fieldTemplatePlaceholder')}</option>
                {STARTERS.map(template => <option key={template.key} value={template.key}>{template.key}</option>)}
              </select>
            </span>
          </div>
        ) : undefined}
        <label className="cap-field">
          <span className="cap-fieldLabel">{t('fieldScope')}</span>
          <span className="cap-fieldControl cap-radios">
            <label><input type="radio" name="cap-scope" checked={form.scope === 'global'} onChange={() => { patch({ scope: 'global' }) }} /> {t('scopeGlobal')}</label>
            <label><input type="radio" name="cap-scope" checked={form.scope === 'profile'} onChange={() => { patch({ scope: 'profile' }) }} /> {t('groupProfile', { name: profileName })}</label>
            {projectRoot === undefined ? undefined : (
              <label><input type="radio" name="cap-scope" checked={form.scope === 'project'} onChange={() => { patch({ scope: 'project' }) }} /> {t('groupProject', { name: projectTitle })}</label>
            )}
          </span>
        </label>
        <label className="cap-field">
          <span className="cap-fieldLabel">{t('fieldName')}</span>
          <span className="cap-fieldControl">
            <input value={form.serverName} onChange={event => { patch({ serverName: event.currentTarget.value }) }} placeholder="github" />
          </span>
        </label>
        <div className="cap-field">
          <span className="cap-fieldLabel">{t('fieldTransport')}</span>
          <span className="cap-fieldControl cap-radios">
            <label><input type="radio" name="cap-transport" checked={form.transport === 'stdio'} onChange={() => { patch({ transport: 'stdio' }) }} /> stdio</label>
            <label><input type="radio" name="cap-transport" checked={form.transport === 'streamable-http'} onChange={() => { patch({ transport: 'streamable-http' }) }} /> Streamable HTTP</label>
          </span>
        </div>

        {form.transport === 'stdio' ? (
          <>
            <label className="cap-field">
              <span className="cap-fieldLabel">{t('fieldCommand')}</span>
              <span className="cap-fieldControl">
                <input value={form.command} onChange={event => { patch({ command: event.currentTarget.value }) } } placeholder="npx" />
              </span>
            </label>
            <label className="cap-field">
              <span className="cap-fieldLabel">{t('fieldArgs')}</span>
              <span className="cap-fieldControl">
                <textarea rows={2} value={form.argsText} onChange={event => { patch({ argsText: event.currentTarget.value }) }} placeholder={'-y\n@modelcontextprotocol/server-github'} />
              </span>
            </label>
            <label className="cap-field">
              <span className="cap-fieldLabel">{t('fieldCwd')}</span>
              <span className="cap-fieldControl">
                <input value={form.cwd} onChange={event => { patch({ cwd: event.currentTarget.value }) }} />
              </span>
            </label>
            <KeyValueEditor
              t={t} title={t('fieldEnv')} rows={form.env}
              onChange={env => { patch({ env }) }} valuePlaceholder="!!js process.env.MY_TOKEN"
            />
          </>
        ) : (
          <>
            <label className="cap-field">
              <span className="cap-fieldLabel">URL</span>
              <span className="cap-fieldControl">
                <input value={form.url} onChange={event => { patch({ url: event.currentTarget.value }) }} placeholder="https://mcp.example.com/mcp" />
              </span>
            </label>
            <KeyValueEditor
              t={t} title={t('fieldHeaders')} rows={form.headers}
              onChange={headers => { patch({ headers }) }} valuePlaceholder="!!js process.env.MY_TOKEN"
            />
          </>
        )}

        <details className="cap-advanced">
          <summary>{t('fieldAdvanced')}</summary>
          <label className="cap-field">
            <span className="cap-fieldLabel">{t('fieldTimeout')}</span>
            <span className="cap-fieldControl">
              <input inputMode="numeric" value={form.timeoutText} onChange={event => { patch({ timeoutText: event.currentTarget.value }) }} placeholder="60000" />
            </span>
          </label>
          <label className="cap-field cap-check">
            <input type="checkbox" checked={form.failOnStartupError} onChange={event => { patch({ failOnStartupError: event.currentTarget.checked }) }} />
            <span>{t('fieldFailFast')}</span>
          </label>
        </details>

        <div className="cap-field cap-check">
          <input id="cap-enabled" type="checkbox" checked={form.enabled} onChange={event => { patch({ enabled: event.currentTarget.checked }) }} />
          <label htmlFor="cap-enabled">{t('fieldEnabled')}</label>
        </div>
       </div>
      </div>

      <p className="cap-hint">{t('envExprHint')}</p>

      <div className="cap-editor-actions">
        <button type="button" className="cap-button" disabled={testing} onClick={test}>{testing ? `${t('testConnection')}…` : t('testConnection')}</button>
        <span className="cap-spacer" />
        <button type="button" className="cap-button" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="cap-button cap-primary" disabled={saving} onClick={save}>{t('saveApply')}</button>
      </div>

      {testResult === undefined ? undefined : (
        <div className="cap-test-result">
          {testResult.ok ? (
            <>
              <Tag tone="success">{t('testOk', { ms: String(testResult.durationMs) })}</Tag>
              {testResult.serverInfo === undefined ? undefined : (
                <span> {testResult.serverInfo.name} v{testResult.serverInfo.version} · {t('toolsCount', { count: String(testResult.toolNames?.length ?? 0) })}</span>
              )}
              {testResult.error === undefined ? undefined : <p className="cap-hint">{testResult.error}</p>}
            </>
          ) : (
            <>
              <Tag tone="danger">{t('testFailed')}</Tag>
              <p className="cap-error-text">{testResult.error}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function KeyValueEditor({ t, title, rows, onChange, valuePlaceholder }: {
  t: Translate
  title: string
  rows: readonly KeyValueRow[]
  onChange(rows: readonly KeyValueRow[]): void
  valuePlaceholder: string
}): ReactNode {
  const update = (at: number, changes: Partial<KeyValueRow>): void => {
    onChange(rows.map((row, index) => index === at ? { ...row, ...changes } : row))
  }
  return (
    <div className="cap-field">
      <span className="cap-fieldLabel">{title}</span>
      <div className="cap-kv">
        {rows.map((row, index) => (
          <div className="cap-kv-row" key={index}>
            <input className="cap-kv-key" value={row.key} placeholder="KEY"
              onChange={event => { update(index, { key: event.currentTarget.value, masked: false }) }} />
            <input className="cap-kv-value" value={row.value} placeholder={row.masked ? t('maskedValue') : valuePlaceholder}
              onChange={event => { update(index, { value: event.currentTarget.value, masked: false }) }} />
            <button type="button" className="cap-kv-remove" aria-label={t('removeEntry')} onClick={() => { onChange(rows.filter((_, at) => at !== index)) }}>×</button>
          </div>
        ))}
        <button type="button" className="cap-button cap-kv-add" onClick={() => { onChange([...rows, { key: '', value: '', masked: false }]) }}>+ {t('addEntry')}</button>
      </div>
    </div>
  )
}

function recordOf(rows: readonly KeyValueRow[]): Record<string, string | null> {
  const record: Record<string, string | null> = {}
  for (const row of rows) {
    if (row.key.trim() === '') continue
    record[row.key.trim()] = row.masked && row.value === '' ? null : row.value
  }
  return record
}

function initialForm(entry: McpServerEntry | undefined, projectRoot: string | undefined, prefill: McpConfigView | undefined): FormState {
  const config = entry?.config
  const rowsOf = (record: Readonly<Record<string, string | null>> | undefined): readonly KeyValueRow[] =>
    Object.entries(record ?? {}).map(([key, value]) => ({ key, value: value ?? '', masked: value === null }))
  const base: FormState = {
    scope: entry !== undefined && entry.scope === 'global' ? 'global'
      : entry !== undefined && entry.scope === 'project' ? 'project'
        : projectRoot !== undefined && entry === undefined ? 'project' : 'profile',
    serverName: config?.serverName ?? entry?.serverName ?? '',
    transport: config?.transport ?? 'stdio',
    command: config?.command ?? '',
    argsText: (config?.args ?? []).join('\n'),
    cwd: config?.cwd ?? '',
    env: rowsOf(config?.env),
    url: config?.url ?? '',
    headers: rowsOf(config?.headers),
    timeoutText: config?.toolCallTimeoutMs === undefined ? '' : String(config.toolCallTimeoutMs),
    failOnStartupError: config?.failOnStartupError ?? false,
    enabled: entry?.enabled ?? true,
  }
  if (entry !== undefined || prefill === undefined) return base
  return {
    ...base,
    transport: prefill.transport,
    serverName: prefill.serverName,
    command: prefill.command ?? '',
    argsText: (prefill.args ?? []).join('\n'),
    env: rowsOf(prefill.env),
    url: prefill.url ?? '',
    headers: rowsOf(prefill.headers),
    ...(prefill.toolCallTimeoutMs === undefined ? {} : { timeoutText: String(prefill.toolCallTimeoutMs) }),
  }
}

/**
 * The mcpServers import wizard (DESIGN.md §7.1/§8.4): paste or upload a
 * Claude / Cursor / Cline / Roo / VS Code configuration, preview the
 * converted entries (rename and protocol warnings, a credential form for
 * `${input:…}` placeholders), pick a target scope, then apply each selected
 * entry through the regular write path — shared validation comes free.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImportInput, ImportPreview, ImportPreviewEntry, McpConfigView, WriteScope } from '../types.ts'
import { fetchUrlText } from './files.ts'
import type { CapabilitiesActions } from './CapabilitiesPage.tsx'
import type { Translate } from './shims.ts'

interface ApplyResult {
  readonly name: string
  readonly ok: boolean
  readonly message: string
}

export interface ImportWizardProps {
  readonly t: Translate
  readonly profileName: string
  readonly projectRoot: string | undefined
  readonly projectTitle: string
  readonly actions: CapabilitiesActions
  readonly onClose: () => void
  readonly onApplied: (notice: string) => void
}

export function ImportWizard({ t, profileName, projectRoot, projectTitle, actions, onClose, onApplied }: ImportWizardProps): ReactNode {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [scope, setScope] = useState<WriteScope>('profile')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [values, setValues] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<readonly ApplyResult[] | undefined>(undefined)

  const parse = (source: string): void => {
    setError(undefined)
    void actions.previewImport(source).then(found => {
      setPreview(found)
      setSelected(new Set(found.entries.map(entry => entry.name)))
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  /** Fetch the mcpServers document in the browser and parse straight into the preview. */
  const loadFromUrl = (): void => {
    const target = url.trim()
    if (target === '') return
    setFetching(true)
    setError(undefined)
    void fetchUrlText(target).then(document => {
      setFetching(false)
      setText(document)
      parse(document)
    }, (cause: unknown) => {
      setFetching(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const inputFields = useMemo(() => {
    if (preview === undefined) return [] as readonly ImportInput[]
    const map = new Map<string, ImportInput>()
    for (const entry of preview.entries) {
      for (const input of entry.inputs) {
        if (!map.has(input.id)) map.set(input.id, input)
      }
    }
    return [...map.values()]
  }, [preview])

  const missingInput = (entry: ImportPreviewEntry): boolean =>
    entry.inputs.some(input => (values[input.id] ?? '').trim() === '')

  const chosen = preview?.entries.filter(entry => selected.has(entry.name)) ?? []
  const blocked = chosen.some(entry => missingInput(entry))

  const apply = (): void => {
    setApplying(true)
    void (async () => {
      const applied: ApplyResult[] = []
      for (const entry of chosen) {
        try {
          await actions.write(scope, substituteInputs(entry.config, values), true, scope === 'project' ? projectRoot : undefined)
          applied.push({ name: entry.name, ok: true, message: t('importAppliedOne') })
        } catch (cause) {
          applied.push({ name: entry.name, ok: false, message: cause instanceof Error ? cause.message : String(cause) })
        }
      }
      setResults(applied)
      setApplying(false)
      const okCount = applied.filter(result => result.ok).length
      onApplied(t('importDoneNotice', { count: String(okCount), total: String(applied.length) }))
    })()
  }

  return (
    <div className="cap-editor">
      <div className="cap-editor-top">
        <button type="button" className="cap-crumb" onClick={onClose}>‹ {t('tabMcp')}</button>
      </div>
      <h2 className="cap-editor-title">{t('importTitle')}</h2>

      {results !== undefined ? (
        <div className="cap-form">
          <ul className="cap-list-rows">
            {results.map(result => (
              <li key={result.name} className="cap-row">
                <div className="cap-row-main">
                  <span className="cap-row-title">{result.name}</span>
                  <span className={result.ok ? 'cap-result-ok' : 'cap-result-bad'}> {result.ok ? '✓' : '✗'} {result.message}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="cap-editor-actions">
            <span className="cap-spacer" />
            <button type="button" className="cap-button cap-primary" onClick={onClose}>{t('closePanel')}</button>
          </div>
        </div>
      ) : preview === undefined ? (
        <div className="cap-form">
         <div className="cap-fieldset">
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('importPaste')}</span>
            <div className="cap-fieldControl">
              <textarea className="cap-skill-body" rows={12} value={text}
                onChange={event => { setText(event.currentTarget.value) }}
                placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} />
            </div>
          </div>
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('importPickJson')}</span>
            <div className="cap-fieldControl cap-file-row">
              <input type="file" accept=".json,application/json" aria-label={t('importPickFile')}
                onChange={event => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file === undefined) return
                  void file.text().then(setText, () => undefined)
                }} />
            </div>
          </div>
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('importFromUrl')}</span>
            <div className="cap-fieldControl cap-file-row">
              <input type="url" placeholder="https://example.com/mcp.json" value={url} aria-label={t('importFromUrl')}
                onChange={event => { setUrl(event.currentTarget.value) }}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); loadFromUrl() } }} />
              <button type="button" className="cap-button" disabled={fetching || url.trim() === ''} onClick={loadFromUrl}>
                {fetching ? `${t('urlLoad')}…` : t('urlLoad')}
              </button>
            </div>
            <p className="cap-hint">{t('urlHint')}</p>
          </div>
         </div>
          {error === undefined ? undefined : <p className="cap-error-text" role="alert">{error}</p>}
          <div className="cap-editor-actions">
            <span className="cap-spacer" />
            <button type="button" className="cap-button" onClick={onClose}>{t('cancel')}</button>
            <button type="button" className="cap-button cap-primary" disabled={text.trim() === ''} onClick={() => { parse(text) }}>{t('importParse')}</button>
          </div>
        </div>
      ) : (
        <div className="cap-form">
         <div className="cap-fieldset">
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('importScopeHint')}</span>
            <span className="cap-fieldControl cap-radios">
              <label><input type="radio" name="cap-import-scope" checked={scope === 'global'} onChange={() => { setScope('global') }} /> {t('scopeGlobal')}</label>
              <label><input type="radio" name="cap-import-scope" checked={scope === 'profile'} onChange={() => { setScope('profile') }} /> {t('groupProfile', { name: profileName })}</label>
              {projectRoot === undefined ? undefined : (
                <label><input type="radio" name="cap-import-scope" checked={scope === 'project'} onChange={() => { setScope('project') }} /> {t('groupProject', { name: projectTitle })}</label>
              )}
            </span>
          </div>

          {inputFields.length === 0 ? undefined : (
            <div className="cap-field">
              <span className="cap-fieldLabel">{t('importInputsTitle')}</span>
              <div className="cap-fieldControl">
                {inputFields.map(input => (
                  <input key={input.id} type={input.password === true ? 'password' : 'text'}
                    value={values[input.id] ?? ''} placeholder={input.description ?? input.id}
                    aria-label={input.id}
                    onChange={event => {
                      const value = event.currentTarget.value
                      setValues(current => ({ ...current, [input.id]: value }))
                    }} />
                ))}
                <p className="cap-hint">{t('importInputHint')}</p>
              </div>
            </div>
          )}
         </div>

          <ul className="cap-list-rows">
            {preview.entries.map(entry => {
              const checked = selected.has(entry.name)
              return (
                <li key={entry.name} className="cap-row">
                  <input className="cap-row-check" type="checkbox" checked={checked} aria-label={entry.name}
                    onChange={event => {
                      const nextChecked = event.currentTarget.checked
                      setSelected(current => {
                        const next = new Set(current)
                        if (nextChecked) next.add(entry.name)
                        else next.delete(entry.name)
                        return next
                      })
                    }} />
                  <div className="cap-row-main">
                    <span className="cap-row-title">
                      {entry.name}
                      {entry.renamed === true ? <Tag tone="warning">{t('importRenamed')}</Tag> : null}
                      <Tag tone="quiet">{entry.transport}</Tag>
                    </span>
                    <span className="cap-row-sub">{summaryOf(entry.config)}</span>
                    {entry.warnings.map(warning => <span key={warning} className="cap-warn">⚠ {warning}</span>)}
                    {checked && missingInput(entry) ? <span className="cap-error-row">{t('importInputMissing')}</span> : undefined}
                    <details>
                      <summary className="cap-hint">JSON</summary>
                      <pre className="cap-pre">{JSON.stringify(entry.config, null, 2)}</pre>
                    </details>
                  </div>
                </li>
              )
            })}
          </ul>

          {preview.errors.length === 0 ? undefined : (
            <>
              <h3 className="cap-section-title">{t('importFailedRows')}</h3>
              <ul className="cap-list-rows">
                {preview.errors.map(reason => (
                  <li key={reason} className="cap-row"><div className="cap-row-main"><span className="cap-error-row">{reason}</span></div></li>
                ))}
              </ul>
            </>
          )}

          <div className="cap-editor-actions">
            <button type="button" className="cap-button" disabled={applying} onClick={() => { setPreview(undefined); setSelected(new Set()) }}>{t('importAgain')}</button>
            <span className="cap-spacer" />
            <button type="button" className="cap-button" disabled={applying} onClick={onClose}>{t('cancel')}</button>
            <button type="button" className="cap-button cap-primary" disabled={applying || chosen.length === 0 || blocked} onClick={apply}>
              {applying ? `${t('importApply')}…` : t('importApplyCount', { count: String(chosen.length) })}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Deep-replace `${input:id}` placeholders with the wizard's values. */
function substituteInputs(config: McpConfigView, values: Readonly<Record<string, string>>): McpConfigView {
  const replace = (text: string): string =>
    text.replace(/\$\{input:([^}]*)\}/g, (_match, id: string) => values[id] ?? '')
  const replaceRecord = (record: Readonly<Record<string, string | null>>): Record<string, string | null> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value === null ? null : replace(value)]))
  return {
    ...config,
    ...(config.command !== undefined ? { command: replace(config.command) } : {}),
    ...(config.args !== undefined ? { args: config.args.map(replace) } : {}),
    ...(config.cwd !== undefined ? { cwd: replace(config.cwd) } : {}),
    ...(config.env !== undefined ? { env: replaceRecord(config.env) } : {}),
    ...(config.url !== undefined ? { url: replace(config.url) } : {}),
    ...(config.headers !== undefined ? { headers: replaceRecord(config.headers) } : {}),
  }
}

function summaryOf(config: McpConfigView): string {
  if (config.transport === 'stdio') return [config.command ?? '', ...(config.args ?? [])].join(' ')
  return config.url ?? ''
}

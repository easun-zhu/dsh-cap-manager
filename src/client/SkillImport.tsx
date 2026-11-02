/**
 * The skills import view (DESIGN.md §8.4): pick a .zip archive, a folder, or
 * loose .md files, choose the target bucket, and import through
 * `importSkills` — the Host validates names/frontmatter and skips or
 * replaces per the overwrite toggle. Results list imported names and
 * skipped reasons.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ImportFilePayload, ImportSkillsResult, WriteSkillRequest } from '../types.ts'
import { fetchUrlBytes, toBase64, unzipFiles } from './files.ts'
import type { CapabilitiesActions } from './CapabilitiesPage.tsx'
import type { Translate } from './shims.ts'

type ScopeDir = WriteSkillRequest['scopeDir']

const FILE_LIMIT = 2 * 1024 * 1024

export interface SkillImportProps {
  readonly t: Translate
  readonly projectRoot: string | undefined
  readonly actions: CapabilitiesActions
  readonly onClose: () => void
  readonly onImported: (notice: string) => void
}

export function SkillImport({ t, projectRoot, actions, onClose, onImported }: SkillImportProps): ReactNode {
  const [scopeDir, setScopeDir] = useState<ScopeDir>(projectRoot === undefined ? 'user-dsh' : 'project-dsh')
  const [files, setFiles] = useState<readonly ImportFilePayload[]>([])
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<ImportSkillsResult | undefined>(undefined)

  const stage = (payloads: readonly ImportFilePayload[]): void => {
    setResult(undefined)
    setError(undefined)
    setFiles(payloads)
  }

  /** Fetch a .zip archive in the browser and unpack it into the staging list. */
  const loadFromUrl = (): void => {
    const target = url.trim()
    if (target === '') return
    setFetching(true)
    setError(undefined)
    void fetchUrlBytes(target).then(bytes => {
      setFetching(false)
      stage(unzipFiles(bytes))
    }, (cause: unknown) => {
      setFetching(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const readFiles = async (list: FileList, pathOf: (file: File) => string): Promise<void> => {
    const payloads: ImportFilePayload[] = []
    for (const file of Array.from(list)) {
      if (file.size > FILE_LIMIT || file.size === 0) continue
      if (file.name === '.DS_Store' || file.name === 'Thumbs.db') continue
      payloads.push({ path: pathOf(file), base64: toBase64(new Uint8Array(await file.arrayBuffer())) })
    }
    stage(payloads)
  }

  const run = (): void => {
    setBusy(true)
    setError(undefined)
    void actions.importSkills({
      scopeDir,
      ...(scopeDir === 'project-dsh' || scopeDir === 'project-agents' ? { projectRoot } : {}),
      files,
      overwrite,
    }).then(outcome => {
      setBusy(false)
      setResult(outcome)
      onImported(t('skillImportDone', { count: String(outcome.imported.length) }))
    }, (cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const totalBytes = files.reduce((sum, file) => sum + Math.floor(file.base64.length * 0.75), 0)

  const scopeOptions: { dir: ScopeDir; label: string }[] = [
    { dir: 'user-dsh', label: t('skillScopeUserDsh') },
    { dir: 'user-agents', label: t('skillScopeUserAgents') },
    ...(projectRoot === undefined ? [] : [
      { dir: 'project-dsh' as const, label: t('skillScopeProjectDsh') },
      { dir: 'project-agents' as const, label: t('skillScopeProjectAgents') },
    ]),
  ]

  return (
    <div className="cap-editor">
      <div className="cap-editor-top">
        <button type="button" className="cap-crumb" onClick={onClose}>‹ {t('tabSkills')}</button>
      </div>
      <h2 className="cap-editor-title">{t('skillImportTitle')}</h2>

      <div className="cap-form">
       <div className="cap-fieldset">
        <div className="cap-field">
          <span className="cap-fieldLabel">{t('fieldScope')}</span>
          <span className="cap-fieldControl cap-radios">
            {scopeOptions.map(option => (
              <label key={option.dir}>
                <input type="radio" name="cap-skill-import-scope" checked={scopeDir === option.dir}
                  onChange={() => { setScopeDir(option.dir) }} /> {option.label}
              </label>
            ))}
          </span>
        </div>

        <div className="cap-field">
          <span className="cap-fieldLabel">{t('skillImportPick')}</span>
          <div className="cap-fieldControl cap-file-row">
            <label className="cap-button">
              {t('skillImportZip')}
              <input type="file" accept=".zip" className="cap-sr-only" aria-label={t('skillImportZip')}
                onChange={event => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file === undefined) return
                  void file.arrayBuffer().then(buffer => { stage(unzipFiles(new Uint8Array(buffer))) }, () => undefined)
                }} />
            </label>
            <label className="cap-button">
              {t('skillImportFolder')}
              <input type="file" multiple className="cap-sr-only"
                // @ts-expect-error -- non-standard but universal folder picker attribute
                webkitdirectory=""
                aria-label={t('skillImportFolder')}
                onChange={event => {
                  const list = event.currentTarget.files
                  event.currentTarget.value = ''
                  if (list === null) return
                  void readFiles(list, file => {
                    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
                    return relative !== undefined && relative !== '' ? relative : file.name
                  })
                }} />
            </label>
            <label className="cap-button">
              {t('skillImportFiles')}
              <input type="file" multiple accept=".md,text/markdown" className="cap-sr-only" aria-label={t('skillImportFiles')}
                onChange={event => {
                  const list = event.currentTarget.files
                  event.currentTarget.value = ''
                  if (list === null) return
                  void readFiles(list, file => file.name)
                }} />
            </label>
          </div>
        </div>

        <div className="cap-field">
          <span className="cap-fieldLabel">{t('importFromUrl')}</span>
          <div className="cap-fieldControl cap-file-row">
            <input type="url" placeholder="https://example.com/skills.zip" value={url} aria-label={t('importFromUrl')}
              onChange={event => { setUrl(event.currentTarget.value) }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); loadFromUrl() } }} />
            <button type="button" className="cap-button" disabled={fetching || url.trim() === ''} onClick={loadFromUrl}>
              {fetching ? `${t('urlLoad')}…` : t('urlLoad')}
            </button>
          </div>
          <p className="cap-hint">{t('urlHint')}</p>
        </div>

        <div className="cap-field cap-check">
          <input id="cap-skill-overwrite" type="checkbox" checked={overwrite}
            onChange={event => { setOverwrite(event.currentTarget.checked) }} />
          <label htmlFor="cap-skill-overwrite">{t('skillImportOverwrite')}</label>
        </div>
       </div>

        {files.length === 0 ? undefined : (
          <p className="cap-hint">
            {t('skillImportStaged', { count: String(files.length), size: `${Math.ceil(totalBytes / 1024)} KB` })}
          </p>
        )}

        {error === undefined ? undefined : <p className="cap-error-text" role="alert">{error}</p>}

        {result === undefined ? undefined : (
          <div className="cap-list-rows">
            {result.imported.map(item => (
              <div key={item.file} className="cap-row">
                <div className="cap-row-main">
                  <span className="cap-row-title">{item.name}</span>
                  <span className="cap-result-ok"> ✓ {t('skillImportImported')}</span>
                </div>
              </div>
            ))}
            {result.skipped.map(item => (
              <div key={item.path} className="cap-row">
                <div className="cap-row-main">
                  <span className="cap-row-title">{item.path}</span>
                  <span className="cap-result-bad"> — {item.reason}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="cap-editor-actions">
          <span className="cap-spacer" />
          <button type="button" className="cap-button" disabled={busy} onClick={onClose}>{t('closePanel')}</button>
          <button type="button" className="cap-button cap-primary" disabled={busy || files.length === 0} onClick={run}>
            {busy ? `${t('skillImportRun')}…` : t('skillImportRun')}
          </button>
        </div>
      </div>
    </div>
  )
}

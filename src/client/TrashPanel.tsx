/**
 * Trash and backup management (DESIGN.md §10): trashed skills restore to
 * their recorded original path or die permanently, and `.cap-bak-*` copies
 * of every managed file (patches, project mcp.yml, SKILL.md) restore over
 * their target or get cleaned up. Restores confirm; deletions confirm twice
 * as loud.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { BackupEntry, TrashEntry } from '../types.ts'
import type { CapabilitiesActions } from './CapabilitiesPage.tsx'
import type { Translate } from './shims.ts'

export interface TrashPanelProps {
  readonly t: Translate
  readonly actions: CapabilitiesActions
  readonly onClose: () => void
  /** Refresh the main lists (a restore/backup-restore changes them). */
  readonly onChanged: () => void
}

export function TrashPanel({ t, actions, onClose, onChanged }: TrashPanelProps): ReactNode {
  const [trash, setTrash] = useState<readonly TrashEntry[] | undefined>(undefined)
  const [backups, setBackups] = useState<readonly BackupEntry[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const reload = (): void => {
    setError(undefined)
    void actions.listTrash().then(setTrash, fail(setError))
    void actions.listBackups().then(setBackups, fail(setError))
  }

  useEffect(() => { reload() }, [])

  const restore = (item: TrashEntry): void => {
    if (item.originalPath === undefined
      || !window.confirm(t('confirmTrashRestore', { name: item.name, path: item.originalPath }))) return
    setBusy(true)
    void actions.restoreTrash(item.id).then(() => {
      setBusy(false)
      reload()
      onChanged()
    }, (cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const destroy = (item: TrashEntry): void => {
    if (!window.confirm(t('confirmTrashDelete', { name: item.name }))) return
    setBusy(true)
    void actions.deleteTrash(item.id).then(() => {
      setBusy(false)
      reload()
    }, (cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const clearAll = (): void => {
    if (trash === undefined || trash.length === 0) return
    if (!window.confirm(t('confirmTrashClear', { count: String(trash.length) }))) return
    setBusy(true)
    void actions.clearTrash().then(() => {
      setBusy(false)
      reload()
    }, (cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const restoreBackup = (entry: BackupEntry): void => {
    if (!window.confirm(t('confirmBackupRestore', { target: entry.target }))) return
    setBusy(true)
    void actions.restoreBackup(entry.file).then(() => {
      setBusy(false)
      reload()
      onChanged()
    }, (cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const destroyBackup = (entry: BackupEntry): void => {
    if (!window.confirm(t('confirmBackupDelete', { target: entry.target }))) return
    setBusy(true)
    void actions.deleteBackup(entry.file).then(() => {
      setBusy(false)
      reload()
    }, (cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <div className="cap-editor">
      <div className="cap-editor-top">
        <button type="button" className="cap-crumb" onClick={onClose}>‹ {t('panel')}</button>
      </div>
      <h2 className="cap-editor-title">{t('trashTitle')}</h2>

      <div className="cap-form">
        {error === undefined ? undefined : <p className="cap-error-text" role="alert">{error}</p>}

        <div className="cap-section-head">
          <h3 className="cap-section-title">{t('trashSection')}</h3>
          {trash !== undefined && trash.length > 0 ? (
            <button type="button" className="cap-button cap-danger" disabled={busy}
              onClick={() => { clearAll() }}>{t('trashClearAll')}</button>
          ) : undefined}
        </div>
        {trash === undefined ? <div className="cap-message">…</div> : trash.length === 0 ? (
          <p className="cap-hint">{t('trashEmpty')}</p>
        ) : (
          <ul className="cap-list-rows">
            {trash.map(item => (
              <li key={item.id} className="cap-row">
                <div className="cap-row-main">
                  <span className="cap-row-title">
                    {item.name}
                    <span className="cap-row-meta"> · {item.kind}</span>
                  </span>
                  <span className="cap-row-sub">
                    {item.originalPath ?? t('trashLegacy')}
                    {item.trashedAt === undefined ? '' : ` · ${new Date(item.trashedAt).toLocaleString()}`}
                  </span>
                </div>
                <div className="cap-row-end">
                  <button type="button" className="cap-button" disabled={busy || item.originalPath === undefined}
                    onClick={() => { restore(item) }}>{t('trashRestore')}</button>
                  <button type="button" className="cap-button cap-danger" disabled={busy}
                    onClick={() => { destroy(item) }}>{t('trashDelete')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3 className="cap-section-title">{t('backupsTitle')}</h3>
        {backups === undefined ? <div className="cap-message">…</div> : backups.length === 0 ? (
          <p className="cap-hint">{t('backupsEmpty')}</p>
        ) : (
          <ul className="cap-list-rows">
            {backups.map(entry => (
              <li key={entry.file} className="cap-row">
                <div className="cap-row-main">
                  <span className="cap-row-title">{entry.target}</span>
                  <span className="cap-row-sub">
                    {entry.time === undefined ? '' : `${new Date(entry.time).toLocaleString()} · `}
                    {Math.ceil(entry.size / 1024)} KB
                  </span>
                </div>
                <div className="cap-row-end">
                  <button type="button" className="cap-button" disabled={busy}
                    onClick={() => { restoreBackup(entry) }}>{t('trashRestore')}</button>
                  <button type="button" className="cap-button cap-danger" disabled={busy}
                    onClick={() => { destroyBackup(entry) }}>{t('trashDelete')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="cap-editor-actions">
          <span className="cap-spacer" />
          <button type="button" className="cap-button" onClick={onClose}>{t('closePanel')}</button>
        </div>
      </div>
    </div>
  )
}

function fail(setError: (message: string) => void): (cause: unknown) => void {
  return cause => { setError(cause instanceof Error ? cause.message : String(cause)) }
}

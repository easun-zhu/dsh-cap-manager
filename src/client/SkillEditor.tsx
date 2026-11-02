/**
 * The skill editor: frontmatter form (name / description / whenToUse, one
 * merged enable toggle covering both invocation flags, target root bucket)
 * plus the markdown body, backed by `readSkill` for display and `writeSkill`
 * for create-or-overwrite. Removal moves the directory into the plugin trash
 * (confirmed here, warned about same-name surfacing by the Host).
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangeOutcome, SkillEntry, WriteSkillRequest } from '../types.ts'
import type { CapabilitiesActions } from './CapabilitiesPage.tsx'
import type { Translate } from './shims.ts'

type ScopeDir = WriteSkillRequest['scopeDir']

interface FormState {
  scopeDir: ScopeDir
  name: string
  description: string
  whenToUse: string
  body: string
  /** One merged switch: writes both modelInvocable and userInvocable. */
  enabled: boolean
}

export interface SkillEditorProps {
  readonly t: Translate
  /** The card being edited; undefined for a new skill. */
  readonly entry: SkillEntry | undefined
  /** Project root enabling the project scope buckets, when a project is selected. */
  readonly projectRoot: string | undefined
  readonly actions: CapabilitiesActions
  readonly onClose: () => void
  readonly onSaved: (outcome: ChangeOutcome) => void
  readonly onRemoved: (outcome: ChangeOutcome) => void
  readonly onError: (message: string) => void
}

export function SkillEditor({ t, entry, projectRoot, actions, onClose, onSaved, onRemoved, onError }: SkillEditorProps): ReactNode {
  const [form, setForm] = useState<FormState>(() => ({
    scopeDir: entry !== undefined && entry.scope === 'project'
      ? (entry.source === 'project-agents' ? 'project-agents' : 'project-dsh')
      : entry !== undefined && entry.source === 'user-agents' ? 'user-agents' : 'user-dsh',
    name: entry?.name ?? '',
    description: entry?.description ?? '',
    whenToUse: entry?.whenToUse ?? '',
    body: '',
    enabled: (entry?.modelInvocable ?? true) || (entry?.userInvocable ?? true),
  }))
  const [loading, setLoading] = useState(entry?.path !== undefined)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (entry?.path === undefined) return
    void actions.readSkill(entry.path).then(file => {
      setForm(current => ({
        ...current,
        name: file.name,
        description: file.description,
        whenToUse: file.whenToUse ?? '',
        body: file.body,
        enabled: file.modelInvocable || file.userInvocable,
      }))
      setLoading(false)
    }, (error: unknown) => {
      setLoading(false)
      onError(error instanceof Error ? error.message : String(error))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per entry
  }, [])

  const patch = (changes: Partial<FormState>): void => {
    setForm(current => ({ ...current, ...changes }))
  }

  const save = (): void => {
    setSaving(true)
    void actions.writeSkill({
      scopeDir: form.scopeDir,
      ...(form.scopeDir === 'project-dsh' || form.scopeDir === 'project-agents'
        ? { projectRoot: projectRoot ?? undefined }
        : {}),
      name: form.name,
      description: form.description,
      ...(form.whenToUse.trim() === '' ? {} : { whenToUse: form.whenToUse }),
      body: form.body,
      modelInvocable: form.enabled,
      userInvocable: form.enabled,
    }).then(outcome => {
      onSaved(outcome)
    }, (error: unknown) => {
      setSaving(false)
      onError(error instanceof Error ? error.message : String(error))
    })
  }

  const remove = (): void => {
    if (entry?.path === undefined || !window.confirm(t('confirmRemoveSkill', { name: entry.name }))) return
    setSaving(true)
    void actions.removeSkill(entry.path).then(outcome => {
      onRemoved(outcome)
    }, (error: unknown) => {
      setSaving(false)
      onError(error instanceof Error ? error.message : String(error))
    })
  }

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
        <span className="cap-spacer" />
        {entry === undefined || entry.path === undefined ? undefined : (
          <button type="button" className="cap-button cap-danger" disabled={saving} onClick={remove}>{t('removeSkill')}</button>
        )}
      </div>
      <h2 className="cap-editor-title">
        {entry === undefined ? t('skillAddTitle') : t('skillEditTitle', { name: entry.name })}
      </h2>

      {loading ? <div className="cap-message">…</div> : (
        <div className="cap-form">
         <div className="cap-fieldset">
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('fieldScope')}</span>
            <span className="cap-fieldControl cap-radios">
              {scopeOptions.map(option => (
                <label key={option.dir}>
                  <input type="radio" name="cap-skill-scope" checked={form.scopeDir === option.dir}
                    onChange={() => { patch({ scopeDir: option.dir }) }} /> {option.label}
                </label>
              ))}
            </span>
          </div>
          <label className="cap-field">
            <span className="cap-fieldLabel">{t('fieldName')}</span>
            <span className="cap-fieldControl">
              <input value={form.name} onChange={event => { patch({ name: event.currentTarget.value }) }} placeholder="my-skill" />
            </span>
          </label>
          <label className="cap-field">
            <span className="cap-fieldLabel">{t('skillFieldDescription')}</span>
            <span className="cap-fieldControl">
              <input value={form.description} onChange={event => { patch({ description: event.currentTarget.value }) }}
                placeholder={t('skillFieldDescriptionPlaceholder')} />
            </span>
          </label>
          <label className="cap-field">
            <span className="cap-fieldLabel">{t('skillFieldWhenToUse')}</span>
            <span className="cap-fieldControl">
              <input value={form.whenToUse} onChange={event => { patch({ whenToUse: event.currentTarget.value }) }} />
            </span>
          </label>
          <div className="cap-field">
            <span className="cap-fieldLabel">{t('skillFieldBody')}</span>
            <div className="cap-fieldControl">
              <textarea className="cap-skill-body" rows={14} value={form.body}
                onChange={event => { patch({ body: event.currentTarget.value }) }}
                placeholder={t('skillFieldBodyPlaceholder')} />
            </div>
          </div>
          <div className="cap-field cap-check">
            <input id="cap-skill-enabled" type="checkbox" checked={form.enabled}
              onChange={event => { patch({ enabled: event.currentTarget.checked }) }} />
            <label htmlFor="cap-skill-enabled">{t('skillFieldEnabled')}</label>
          </div>
         </div>
          <p className="cap-hint">{t('skillFieldEnabledHint')}</p>
          {entry?.shadowed === true ? (
            <p className="cap-hint"><Tag tone="warning">{t('shadowedBadge')}</Tag> {t('shadowedHint', { path: entry.shadowedBy ?? '' })}</p>
          ) : undefined}
        </div>
      )}

      <div className="cap-editor-actions">
        <span className="cap-spacer" />
        <button type="button" className="cap-button" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="cap-button cap-primary" disabled={saving || loading} onClick={save}>{t('saveApply')}</button>
      </div>
    </div>
  )
}

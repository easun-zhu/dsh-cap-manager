/**
 * The Claude Code plugins tab (M6): the built-in `claude-plugins-official`
 * marketplace. Installed plugins and market entries render as compact cards
 * in a responsive grid (ZCode-market style); the market loads one page at a
 * time with a "load more" button. Installs download on the Host, then skills
 * arrive through the plugin's skill provider and MCP servers mount as live
 * fibers.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CcInstallResult, CcMarketEntryView, CcPluginsListResult } from '../types.ts'
import type { CapabilitiesActions } from './CapabilitiesPage.tsx'
import type { Translate } from './shims.ts'

/** One page of market cards; "load more" appends another page each click. */
const MARKET_PAGE_SIZE = 40

export interface CcPluginsPanelProps {
  readonly t: Translate
  readonly actions: CapabilitiesActions
  readonly onNotice: (message: string) => void
  readonly onSkillsChanged: () => void
}

export function CcPluginsPanel({ t, actions, onNotice, onSkillsChanged }: CcPluginsPanelProps): ReactNode {
  const [list, setList] = useState<CcPluginsListResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [visible, setVisible] = useState(MARKET_PAGE_SIZE)

  const reload = useCallback((refresh = false): void => {
    setError(undefined)
    void actions.listCcPlugins(refresh).then(result => {
      setList(result)
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [actions])

  useEffect(() => { reload(false) }, [reload])

  const run = (key: string, work: () => Promise<string>): void => {
    setBusy(key)
    void work().then(notice => {
      setBusy(undefined)
      onNotice(notice)
      reload(true)
      onSkillsChanged()
    }, (cause: unknown) => {
      setBusy(undefined)
      onNotice(`${t('actionFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }

  const install = (name: string): void => {
    run(`install:${name}`, async () => {
      const result = await actions.installCcPlugin(name)
      return summarize(t, result, t('ccInstalled', { name, version: result.version }))
    })
  }

  const update = (name: string): void => {
    run(`update:${name}`, async () => {
      const result = await actions.updateCcPlugin(name)
      return result.upToDate ? t('ccUpToDate', { name }) : summarize(t, result, t('ccUpdated', { name, version: result.version }))
    })
  }

  const uninstall = (name: string): void => {
    if (!window.confirm(t('ccConfirmUninstall', { name }))) return
    run(`uninstall:${name}`, async () => {
      await actions.uninstallCcPlugin(name)
      return t('ccUninstalled', { name })
    })
  }

  const toggle = (name: string, enabled: boolean): void => {
    run(`toggle:${name}`, async () => {
      await actions.setCcPluginEnabled(name, enabled)
      return enabled ? t('ccEnabledNotice', { name }) : t('ccDisabledNotice', { name })
    })
  }

  const installed = list?.entries.filter(entry => entry.installed !== undefined) ?? []
  const needle = query.trim().toLowerCase()
  const market = (list?.entries ?? [])
    .filter(entry => entry.installed === undefined)
    .filter(entry => needle === ''
      || entry.name.toLowerCase().includes(needle)
      || (entry.description ?? '').toLowerCase().includes(needle)
      || (entry.category ?? '').toLowerCase().includes(needle))

  return (
    <div className="cap-editor">
      <div className="cap-editor-top">
        <h2 className="cap-editor-title">{t('ccTitle')}</h2>
        <span className="cap-spacer" />
        <div className="cap-search">
          <input type="search" placeholder={t('searchPlaceholder')} value={query}
            aria-label={t('searchPlaceholder')} onChange={event => {
              setQuery(event.currentTarget.value)
              setVisible(MARKET_PAGE_SIZE)
            }} />
        </div>
        <button type="button" className="cap-button" onClick={() => { reload(true) }}>⟳ {t('ccRefreshMarket')}</button>
      </div>
      <p className="cap-hint">
        {t('ccSourceHint', { count: String(list?.entries.length ?? 0), time: list?.fetchedAt.slice(0, 16).replace('T', ' ') ?? '' })}
      </p>

      <div className="cap-form">
        {error === undefined ? undefined : <p className="cap-error-text" role="alert">{error}</p>}
        {list === undefined && error === undefined ? <div className="cap-message">…</div> : null}

        <h3 className="cap-section-title">{t('ccInstalledGroup')} ({installed.length})</h3>
        {installed.length === 0 ? <div className="cap-empty">{t('ccInstalledEmpty')}</div> : (
          <ul className="cap-cc-grid">
            {installed.map(entry => (
              <CcPluginCard
                key={entry.name}
                t={t}
                entry={entry}
                busy={busy}
                onToggle={toggle}
                onUpdate={update}
                onUninstall={uninstall}
              />
            ))}
          </ul>
        )}

        <h3 className="cap-section-title">{t('ccMarketGroup')} ({market.length})</h3>
        {market.length === 0 ? <div className="cap-empty">{t('noMatches')}</div> : (
          <>
            <ul className="cap-cc-grid">
              {market.slice(0, visible).map(entry => (
                <CcMarketCard key={entry.name} t={t} entry={entry} busy={busy} onInstall={install} />
              ))}
            </ul>
            {market.length > visible ? (
              <div className="cap-cc-more">
                <button type="button" className="cap-button" onClick={() => { setVisible(count => count + MARKET_PAGE_SIZE) }}>
                  {t('ccLoadMore', { count: String(market.length - visible) })}
                </button>
              </div>
            ) : undefined}
          </>
        )}
      </div>
    </div>
  )
}

/** Deterministic tile palette: the same plugin keeps its shade across renders. */
const TILE_COLORS = ['#7c5cff', '#2f8fef', '#12a58c', '#d97706', '#db2777', '#0f766e', '#6d28d9', '#b45309']

function tileColor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return TILE_COLORS[hash % TILE_COLORS.length] ?? TILE_COLORS[0]!
}

/** `<domain>/favicon.ico`; the market index has no icons of its own. */
function faviconUrl(homepage: string | undefined): string | undefined {
  if (homepage === undefined) return undefined
  try {
    return `${new URL(homepage).origin}/favicon.ico`
  } catch {
    return undefined
  }
}

/**
 * Letter tile tinted by category with the plugin site's favicon layered on
 * top: the letter reads while loading and stays as the fallback on failure.
 */
function CcIcon({ entry }: { entry: CcMarketEntryView }): ReactNode {
  const icon = faviconUrl(entry.homepage)
  return (
    <span className="cap-cc-icon" aria-hidden="true" style={{ backgroundColor: tileColor(entry.category ?? entry.name) }}>
      <span className="cap-cc-iconLetter">{entry.name.slice(0, 1).toUpperCase()}</span>
      {icon === undefined ? undefined : (
        <img className="cap-cc-iconImg" src={icon} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
          onLoad={event => { event.currentTarget.style.backgroundColor = 'var(--dsw-alias-bg-layer-2)' }}
          onError={event => { event.currentTarget.style.display = 'none' }} />
      )}
    </span>
  )
}

function CcMarketCard({ t, entry, busy, onInstall }: {
  t: Translate
  entry: CcMarketEntryView
  busy: string | undefined
  onInstall(name: string): void
}): ReactNode {
  return (
    <li className="cap-cc-card">
      <div className="cap-cc-head">
        <CcIcon entry={entry} />
        <span className="cap-cc-name" title={entry.name}>{entry.name}</span>
        {entry.category === undefined ? undefined : <Tag tone="quiet">{entry.category}</Tag>}
      </div>
      <span className="cap-cc-desc" title={entry.description}>{entry.description ?? ''}</span>
      <div className="cap-cc-foot">
        <span className="cap-cc-meta" title={entry.author}>{entry.author ?? ''}</span>
        <span className="cap-spacer" />
        <button type="button" className="cap-button cap-primary" disabled={busy !== undefined}
          onClick={() => { onInstall(entry.name) }}>
          {busy === `install:${entry.name}` ? `${t('ccInstalling')}…` : `⇩ ${t('ccInstall')}`}
        </button>
      </div>
    </li>
  )
}

function CcPluginCard({ t, entry, busy, onToggle, onUpdate, onUninstall }: {
  t: Translate
  entry: CcMarketEntryView
  busy: string | undefined
  onToggle(name: string, enabled: boolean): void
  onUpdate(name: string): void
  onUninstall(name: string): void
}): ReactNode {
  const installed = entry.installed as NonNullable<CcMarketEntryView['installed']>
  const servers = Object.entries(installed.servers)
  return (
    <li className="cap-cc-card" data-cap-status={servers.some(([, view]) => view.status === 'failed') ? 'failed' : undefined}>
      <div className="cap-cc-head">
        <CcIcon entry={entry} />
        <span className="cap-cc-name" title={entry.name}>{entry.name}</span>
        <Tag tone="quiet">v{installed.version}</Tag>
        {installed.updateAvailable ? <Tag tone="warning">{t('ccUpdateAvailable')}</Tag> : null}
        {installed.enabled ? undefined : <Tag tone="neutral">{t('statusDisabled')}</Tag>}
        {installed.skills > 0 ? <Tag tone="quiet">{t('ccSkillsCount', { count: String(installed.skills) })}</Tag> : null}
      </div>
      <span className="cap-cc-desc" title={entry.description}>{entry.description ?? ''}</span>
      {servers.map(([name, view]) => (
        <span key={name} className="cap-cc-server"
          title={view.error === undefined ? `${name} · ${t(`status${capitalize(view.status)}`)}` : `${name}: ${view.error}`}>
          <span className="cap-dot" data-state={view.status} />
          <span className="cap-cc-serverText">
            {name} · {t(`status${capitalize(view.status)}`)}
            {view.toolCount > 0 ? ` · ${t('toolsCount', { count: String(view.toolCount) })}` : ''}
            {view.error === undefined ? '' : ` — ${view.error}`}
          </span>
        </span>
      ))}
      {installed.skippedContent.length === 0 ? undefined : (
        <span className="cap-cc-meta">{t('ccSkippedContent', { content: installed.skippedContent.join(', ') })}</span>
      )}
      <div className="cap-cc-foot">
        <Switch
          checked={installed.enabled}
          onChange={next => { onToggle(entry.name, next) }}
          label={t('ccToggleAria', { name: entry.name })}
        />
        <span className="cap-spacer" />
        <button type="button" className="cap-button" disabled={busy !== undefined} onClick={() => { onUpdate(entry.name) }}>
          {busy === `update:${entry.name}` ? `${t('ccUpdating')}…` : t('ccUpdate')}
        </button>
        <button type="button" className="cap-button cap-danger" disabled={busy !== undefined} onClick={() => { onUninstall(entry.name) }}>
          {t('ccUninstall')}
        </button>
      </div>
    </li>
  )
}

function summarize(t: Translate, result: CcInstallResult, headline: string): string {
  const parts: string[] = [headline]
  if (result.skills.length > 0) parts.push(t('ccResultSkills', { count: String(result.skills.length) }))
  if (result.servers.length > 0) parts.push(t('ccResultServers', { count: String(result.servers.length) }))
  if (result.warnings.length > 0) parts.push(`${t('ccResultWarnings')}: ${result.warnings.join('; ')}`)
  if (result.skippedContent.length > 0) parts.push(t('ccSkippedContent', { content: result.skippedContent.join(', ') }))
  return parts.join(' · ')
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

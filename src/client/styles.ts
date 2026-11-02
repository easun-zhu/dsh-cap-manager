/**
 * Panel styles riding the Host design-token system (--dsw-alias-*): cards are
 * layered surfaces (bg-layer-2 over bg-base) whose live state paints a left
 * edge and an icon tile (--cap-status-color), so the lists read as a status
 * board. Tone colors come from the state-* tokens the Host primitives use, so
 * light/dark themes follow the Host for free.
 * Injected once per page as a <style> side effect at bundle materialization.
 */

const STYLE_ID = 'dsh-cap-manager-styles'

const CSS = `
.cap-page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13.5px; }
.cap-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px 10px; flex-wrap: wrap; }
.cap-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
.cap-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; padding: 5px 14px; border-radius: 9px; cursor: pointer; transition: color .15s ease, background .15s ease; }
.cap-tab:hover { color: var(--dsw-alias-label-primary); }
.cap-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2); box-shadow: 0 1px 2px rgba(9,14,30,.1), inset 0 0 0 .5px var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.cap-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.cap-search { flex: 1 1 160px; max-width: 260px; }
.cap-search input { width: 100%; box-sizing: border-box; height: 30px; padding: 0 12px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; }
.cap-search input::placeholder { color: var(--dsw-alias-label-tertiary); }
.cap-search input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.cap-project-select select { height: 30px; padding: 0 8px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; max-width: 220px; cursor: pointer; }
.cap-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.cap-spacer { flex: 1; }
.cap-button { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px; border: 1px solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; text-decoration: none; }
.cap-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cap-button:active { background: var(--dsw-alias-interactive-bg-active); }
.cap-button:disabled { cursor: not-allowed; opacity: .45; }
.cap-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.cap-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font-weight: 500; }
.cap-primary:hover { background: var(--dsw-alias-button-primary-hover); }
.cap-danger { color: var(--dsw-alias-state-error-primary); }
.cap-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.cap-notice { display: flex; align-items: baseline; gap: 8px; margin: 0 16px 10px; padding: 7px 12px; border-radius: var(--dsw-radius-md); font-size: 12.5px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); color: var(--dsw-alias-label-primary); }
.cap-notice::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; align-self: center; background: var(--dsw-alias-state-business-primary); }
.cap-notice-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.cap-notice-error::before { background: var(--dsw-alias-state-error-primary); }
.cap-body { flex: 1; overflow-y: auto; padding: 0 16px 20px; }
.cap-group { margin: 0 0 18px; }
.cap-group-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 10px 2px 8px; margin: 0; }
.cap-group-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 17px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-tertiary); font-size: 11px; font-weight: 500; }
.cap-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.cap-card { --cap-status-color: var(--dsw-alias-state-idle-primary); position: relative; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); padding: 12px 16px 10px 18px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; transition: border-color .15s ease, box-shadow .15s ease; }
.cap-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--cap-status-color); opacity: .9; }
.cap-card:hover { border-color: var(--dsw-alias-border-l3); box-shadow: 0 2px 10px rgba(9,14,30,.08); }
.cap-card[data-cap-status="connected"] { --cap-status-color: var(--dsw-alias-state-success-primary); }
.cap-card[data-cap-status="connecting"] { --cap-status-color: var(--dsw-alias-state-warn-primary); }
.cap-card[data-cap-status="failed"] { --cap-status-color: var(--dsw-alias-state-error-primary); }
.cap-card[data-cap-status="stopped"], .cap-card[data-cap-status="disabled"] { --cap-status-color: var(--dsw-alias-border-l4); }
.cap-card[data-cap-status="stopped"] .cap-cardTitle, .cap-card[data-cap-status="disabled"] .cap-cardTitle { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.cap-cardHead { display: flex; align-items: flex-start; gap: 12px; }
.cap-cardIcon { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: color-mix(in srgb, var(--cap-status-color) 12%, transparent); color: var(--cap-status-color); flex: none; margin-top: 1px; }
.cap-cardIcon svg { display: block; }
.cap-cardMain { flex: 1; min-width: 0; }
.cap-titleRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cap-cardTitle { font-weight: 600; font-size: 14px; }
.cap-cardDesc { display: block; margin-top: 4px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 64ch; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; }
.cap-cardFoot { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.cap-cardFootNote { font-size: 12px; color: var(--dsw-alias-label-caption); }
.cap-cardEnd { flex: none; display: flex; align-items: center; gap: 6px; margin-left: auto; }
.cap-cardEnd .cap-button { height: 26px; padding: 0 10px; font-size: 12.5px; }
.cap-cardOpen { background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; font-weight: 600; font-size: 14px; }
.cap-cardOpen:hover { color: var(--dsw-alias-brand-primary); }
.cap-error-text { font-size: 12px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); border-radius: var(--dsw-radius-sm); padding: 6px 10px; margin: 8px 0 0; overflow-wrap: anywhere; }
.cap-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; display: inline-block; }
.cap-dot[data-state="connected"] { color: var(--dsw-alias-state-success-primary); }
.cap-dot[data-state="connecting"] { color: var(--dsw-alias-state-warn-primary); }
.cap-dot[data-state="failed"] { color: var(--dsw-alias-state-error-primary); }
.cap-dot[data-state="stopped"], .cap-dot[data-state="disabled"] { color: var(--dsw-alias-state-idle-primary); }
.cap-empty { padding: 36px 16px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); }
.cap-message { margin: 28px 8px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.cap-message code { overflow-wrap: anywhere; }
.cap-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.cap-editor-top { display: flex; align-items: center; gap: 8px; padding: 10px 16px 0; }
.cap-crumb { background: none; border: 0; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; padding: 4px 0; }
.cap-crumb:hover { color: var(--dsw-alias-label-primary); }
.cap-crumb:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.cap-editor-title { font-size: 15px; font-weight: 600; margin: 10px 16px 6px; }
.cap-form { flex: 1; overflow-y: auto; padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
.cap-fieldset { border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-2); padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.cap-field { display: flex; align-items: flex-start; gap: 12px; }
.cap-fieldLabel { flex: 0 0 168px; font-size: 13px; color: var(--dsw-alias-label-secondary); padding-top: 6px; text-align: right; }
.cap-fieldControl { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.cap-fieldControl input[type="text"], .cap-fieldControl input[type="url"], .cap-fieldControl input[type="password"],
.cap-fieldControl input:not([type]), .cap-fieldControl textarea {
  width: 100%; box-sizing: border-box; padding: 6px 12px; border-radius: var(--dsw-radius-md);
  border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit;
}
.cap-fieldControl input:focus-visible, .cap-fieldControl textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.cap-fieldControl textarea { font-family: ui-monospace, Consolas, monospace; font-size: 12px; resize: vertical; }
.cap-radios { flex-direction: row; flex-wrap: wrap; gap: 14px; padding-top: 5px; }
.cap-radios label, .cap-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.cap-check { flex-direction: row; padding-top: 6px; margin-left: 180px; }
.cap-kv { display: flex; flex-direction: column; gap: 5px; }
.cap-kv-row { display: flex; gap: 5px; }
.cap-kv-key { flex: 0 0 200px; }
.cap-kv-value { flex: 1; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.cap-kv-row input { padding: 5px 10px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; }
.cap-kv-remove { border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 15px; }
.cap-kv-remove:hover { color: var(--dsw-alias-state-error-primary); }
.cap-kv-add { align-self: flex-start; font-size: 12px; padding: 3px 10px; }
.cap-advanced { border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); padding: 10px 14px; }
.cap-advanced summary { cursor: pointer; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.cap-advanced .cap-field { margin-top: 10px; }
.cap-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin: 4px 16px; }
.cap-field .cap-hint, .cap-fieldset .cap-hint { margin-left: 0; margin-right: 0; }
.cap-editor-actions { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.cap-test-result { padding: 8px 16px 16px; font-size: 13px; }
.cap-switch-pair { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.cap-switch-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.cap-skill-body { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.5; }
.cap-fieldControl select { padding: 6px 10px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; width: max-content; max-width: 100%; }
.cap-list-rows { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; }
.cap-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); }
.cap-row:hover { border-color: var(--dsw-alias-border-l3); }
.cap-row-check { margin-top: 3px; flex: none; accent-color: var(--dsw-alias-brand-primary); }
.cap-row-main { flex: 1; min-width: 0; }
.cap-row-title { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; font-size: 13px; }
.cap-row-sub { display: block; margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; font-family: ui-monospace, Consolas, monospace; }
.cap-row-meta { font-weight: 400; font-size: 11.5px; color: var(--dsw-alias-label-caption); }
.cap-row-end { flex: none; display: flex; gap: 6px; }
.cap-warn { display: block; margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-state-warn-primary); overflow-wrap: anywhere; }
.cap-error-row { display: block; margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.cap-pre { font-family: ui-monospace, Consolas, monospace; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--dsw-alias-markdown-code-block); border-radius: var(--dsw-radius-sm); padding: 8px; margin: 6px 0 0; }
.cap-file-row { flex-direction: row; flex-wrap: wrap; gap: 8px; align-items: center; }
.cap-file-row input[type="file"] { font-size: 12px; }
.cap-file-row .cap-button { cursor: pointer; }
.cap-file-row input[type="url"] { flex: 1 1 220px; width: auto; }
.cap-cardEnd a.cap-button { text-decoration: none; }
.cap-cc-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.cap-cc-card { --cap-status-color: var(--dsw-alias-border-l4); position: relative; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); display: flex; flex-direction: column; gap: 8px; min-width: 0; transition: border-color .15s ease, box-shadow .15s ease; }
.cap-cc-card:hover { border-color: var(--dsw-alias-border-l3); box-shadow: 0 2px 10px rgba(9,14,30,.08); }
.cap-cc-card[data-cap-status="failed"] { --cap-status-color: var(--dsw-alias-state-error-primary); }
.cap-cc-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.cap-cc-icon { position: relative; flex: none; width: 26px; height: 26px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; }
.cap-cc-iconLetter { font-size: 13px; font-weight: 700; color: #fff; line-height: 1; }
.cap-cc-iconImg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.cap-cc-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.cap-cc-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; min-height: 3em; }
.cap-cc-meta { font-size: 11px; color: var(--dsw-alias-label-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cap-cc-foot { margin-top: auto; display: flex; align-items: center; gap: 6px; min-width: 0; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.cap-cc-more { display: flex; justify-content: center; padding: 10px 0 2px; }
.cap-cc-server { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.cap-cc-serverText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap-result-ok { color: var(--dsw-alias-state-success-primary); font-size: 12.5px; }
.cap-result-bad { color: var(--dsw-alias-state-error-primary); font-size: 12.5px; overflow-wrap: anywhere; }
.cap-section-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 14px 2px 8px; margin: 0; }
.cap-section-head { display: flex; align-items: center; gap: 8px; }
.cap-section-head .cap-section-title { flex: 1; }
.cap-section-head .cap-button { flex: none; }
.cap-form .cap-editor-actions { border-top: 0; padding: 10px 0 0; }
@media (prefers-reduced-motion: reduce) { .cap-tab, .cap-card, .cap-cc-card { transition: none; } }
`

let injected = false

/**
 * Keep exactly one stylesheet in the page; safe to call on every registration.
 * A re-materialized bundle (HMR/reconnect) must refresh a stale element in
 * place — skipping it would run new markup against the previous CSS.
 */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    injected = true
    return
  }
  if (injected) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.append(element)
  injected = true
}

/**
 * The sidebar entry icon for the MCP & Skills panel. The sidebar owns the
 * button, label, and selected state around the glyph this renders.
 */

import type { ReactNode } from 'react'

export function PanelIcon({ size = 20 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10.5" y="10.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.5 6h4a2 2 0 0 1 2 2v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6 9.5V14a2 2 0 0 0 2 2h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

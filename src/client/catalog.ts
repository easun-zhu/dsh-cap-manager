/**
 * Starter templates for the add-editor's template dropdown: well-known MCP
 * servers with ready configs. Data only; `catalogConfig` converts one entry
 * into the config view the editor consumes, so there is exactly one place a
 * starter config lives.
 */

import type { McpConfigView } from '../types.ts'

/** One template in the add-form dropdown. */
export interface CatalogEntry {
  /** Also the suggested serverName; `^[a-z0-9-]+$`. */
  readonly key: string
  readonly transport: 'stdio' | 'streamable-http'
  /** stdio launch; args may contain `<…>` placeholders the user must edit. */
  readonly command?: string
  readonly args?: readonly string[]
  /** Env rows for the add form; values may be `!!js process.env.…` expressions. */
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
}

export const STARTERS: readonly CatalogEntry[] = [
  {
    key: 'filesystem', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
  },
  {
    key: 'memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    key: 'sequential-thinking', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    key: 'fetch', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'],
  },
  {
    key: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '!!js process.env.GITHUB_TOKEN' },
  },
  {
    key: 'puppeteer', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
]

/** Convert one template into the config view the add editor consumes. */
export function catalogConfig(entry: CatalogEntry): McpConfigView {
  return {
    transport: entry.transport,
    serverName: entry.key,
    ...(entry.transport === 'stdio' ? {
      command: entry.command ?? '',
      args: [...(entry.args ?? [])],
      ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
    } : {
      url: entry.url ?? '',
    }),
  }
}

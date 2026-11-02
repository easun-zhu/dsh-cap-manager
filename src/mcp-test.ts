/**
 * Direct MCP connection testing through the SDK, isolated from the harness's
 * tool registry: a passing test never registers `mcp__*` tools with the model
 * catalog. stdio children get the same scrubbed parent environment the
 * mcp-client transport applies (secret-looking and `DSH_*` variables dropped,
 * configured `env` merged on top).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpConfigView } from './types.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const ENV_EXPR = /^!!js process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/
const SCRUBBED_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

export interface TestMcpOutcome {
  readonly ok: boolean
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly toolNames?: readonly string[]
  readonly error?: string
  readonly durationMs: number
}

/** Evaluate the `!!js process.env.NAME` expression form; anything richer tests with its literal text. */
function evaluate(value: string): { value: string; warning?: string } {
  const match = ENV_EXPR.exec(value)
  if (match === null) {
    return value.startsWith('!!js ')
      ? { value, warning: `expression "${value}" is not the supported process.env form; tested literally` }
      : { value }
  }
  return { value: process.env[match[1]] ?? '' , warning: process.env[match[1]] === undefined ? `process.env.${match[1]} is unset` : undefined }
}

function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SCRUBBED_ENV.test(key) || key.startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

/**
 * Connect, discover tools, and disconnect within `timeoutMs`.
 * @param config - the candidate server config (masked `null` values resolve to empty strings).
 */
export async function testMcpConnection(config: McpConfigView, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TestMcpOutcome> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const client = new Client({ name: 'dsh-cap-manager-test', version: '0.1.0' })
  const envInput: Record<string, string | null> = { ...(config.env ?? {}) }
  const headerInput: Record<string, string | null> = { ...(config.headers ?? {}) }
  try {
    const warnings: string[] = []
    if (config.transport === 'stdio') {
      const command = config.command ?? ''
      if (command === '') throw new Error('stdio transport requires a command')
      const env: Record<string, string> = { ...scrubbedParentEnv() }
      for (const [key, raw] of Object.entries(envInput)) {
        if (raw === null) continue
        const resolved = evaluate(raw)
        env[key] = resolved.value
        if (resolved.warning !== undefined) warnings.push(`${key}: ${resolved.warning}`)
      }
      const transport = new StdioClientTransport({
        command,
        args: [...(config.args ?? [])],
        env,
        cwd: config.cwd === undefined || config.cwd === '' ? undefined : evaluate(config.cwd).value,
      })
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs })
    } else {
      const url = config.url ?? ''
      if (url === '') throw new Error('streamable-http transport requires a url')
      const headers: Record<string, string> = {}
      for (const [key, raw] of Object.entries(headerInput)) {
        if (raw === null) continue
        const resolved = evaluate(raw)
        headers[key] = resolved.value
        if (resolved.warning !== undefined) warnings.push(`${key}: ${resolved.warning}`)
      }
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs })
    }
    const [serverInfo, tools] = await Promise.all([
      client.getServerVersion(),
      client.listTools(),
    ])
    return {
      ok: true,
      serverInfo: serverInfo === undefined ? undefined : { name: serverInfo.name, version: serverInfo.version },
      toolNames: tools.tools.map(tool => tool.name),
      durationMs: Date.now() - started,
      ...(warnings.length > 0 ? { error: warnings.join('; ') } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: controller.signal.aborted && !message.includes('aborted')
        ? `timed out after ${String(timeoutMs)} ms`
        : message,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => undefined)
  }
}

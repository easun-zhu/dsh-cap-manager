/**
 * Minimal stdio MCP server for dsh-cap-manager development tests: answers
 * initialize and serves `echo` and `add` tools over stdio. Loads the harness
 * checkout's MCP SDK and zod by absolute path so no installation is needed.
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const SDK_BASE = 'E:/workspaces/github/deepseek-harness/node_modules/.pnpm/@modelcontextprotocol+sdk@1_0f5e26b9cfdddbd01796e96eb16b9ced/node_modules'
const esm = `${SDK_BASE}/@modelcontextprotocol/sdk/dist/esm`

const { McpServer } = await import(pathToFileURL(`${esm}/server/mcp.js`).href)
const { StdioServerTransport } = await import(pathToFileURL(`${esm}/server/stdio.js`).href)
// zod sits beside the SDK inside the pnpm store; resolve it from there.
const requireBesideSdk = createRequire(`${SDK_BASE}/index.js`)
const { z } = requireBesideSdk('zod')

const server = new McpServer({ name: 'mini-test-server', version: '0.1.0' })

server.tool('echo', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}))
server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}))

await server.connect(new StdioServerTransport())

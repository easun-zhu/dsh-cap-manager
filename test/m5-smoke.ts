/**
 * M5 smoke probes (run with: node --experimental-strip-types test/m5-smoke.ts).
 * Verifies the starter-template invariants, the locale coverage of the URL
 * import keys, and market/index.json against the real format-1 validator.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { STARTERS, catalogConfig } from '../src/client/catalog.ts'
import { zh, en } from '../src/client/locales.ts'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures += 1
    console.log(`FAIL - ${label}`, detail ?? '')
  }
}

// ---- starter templates ----
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
check('six unique starter templates', STARTERS.length === 6 && new Set(STARTERS.map(entry => entry.key)).size === STARTERS.length)
check('keys are valid serverNames', STARTERS.every(entry => SERVER_NAME.test(entry.key)))
check('every template is stdio with a command', STARTERS.every(entry => entry.transport === 'stdio' && entry.command !== undefined && entry.command !== ''))

const github = catalogConfig(STARTERS.find(entry => entry.key === 'github')!)
check('github template carries the env expression',
  github.transport === 'stdio' && github.env?.GITHUB_TOKEN === '!!js process.env.GITHUB_TOKEN', github)

// ---- locale coverage ----
const missing: string[] = []
for (const key of ['importFromUrl', 'urlLoad', 'urlHint', 'noMatches']) {
  if (typeof zh[key] !== 'string') missing.push(`zh:${key}`)
  if (typeof en[key] !== 'string') missing.push(`en:${key}`)
}
check('URL import + empty-state keys exist in zh+en', missing.length === 0, missing)

// ---- market index (real format-1 validator) ----
const root = dirname(fileURLToPath(import.meta.url))
const indexRaw = JSON.parse(await readFile(join(root, '..', 'market', 'index.json'), 'utf8'))
const indexUrl = 'https://example.invalid/market/index.json'
try {
  const index = parseMarketIndex(indexRaw, indexUrl)
  check('market/index.json passes the format-1 validator', index.format === 1)
  const plugin = index.plugins.find(candidate => candidate.name === 'dsh-cap-manager')
  check('index lists dsh-cap-manager with versions',
    index.plugins.length === 1 && plugin !== undefined && plugin.versions.length >= 1)
  check('versions descend and the newest installs from npm with the engines floor',
    plugin !== undefined
    && plugin.versions.every((version, at) => at === 0 || plugin.versions[at - 1].publishTimestamp >= version.publishTimestamp)
    && plugin.versions[0].source.type === 'npm'
    && plugin.versions[0].engines.dsh === '>=0.2.1-rc.2')
} catch (error) {
  check('market/index.json passes the format-1 validator', false, error)
}

// package metadata stays in step with the market entry
const pkg = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8')) as {
  version: string
  engines: { dsh: string }
  keywords: string[]
}
check('package.json version is the newest market version', pkg.version === '1.1.0' && pkg.engines.dsh === '>=0.2.1-rc.2')
check('package.json carries the dsh-plugin keyword', pkg.keywords.includes('dsh-plugin'))

if (failures > 0) {
  console.log(`\n${String(failures)} FAILURES`)
  process.exitCode = 1
} else {
  console.log('\nall m5 checks passed')
}

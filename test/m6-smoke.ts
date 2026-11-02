/**
 * M6 smoke probes (run with: node --experimental-strip-types test/m6-smoke.ts).
 * Verifies the tar extractor, the marketplace subtree download (with an
 * injected fetcher — no network), manifest mcpServers conversion, and the
 * marketplace index parsing against a real snapshot fixture.
 */
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gzipSync } from 'fflate'
import { extractTar, parseMarketIndex, CcMarket, isExactPin } from '../src/cc-market.ts'
import type { MarketEntry } from '../src/cc-market.ts'
import { viewToPlain } from '../src/cc-store.ts'
import { convertMcpImport } from '../src/import-mcp.ts'

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures += 1
    console.log(`FAIL - ${label}`, detail ?? '')
  }
}
function throws(label: string, work: () => unknown): void {
  try {
    work()
    failures += 1
    console.log(`FAIL - ${label} (no throw)`)
  } catch {
    console.log(`ok - ${label}`)
  }
}

// ---- tar builder + extractTar ----
function tarEntry(name: string, data: string, typeflag = '0'): Buffer[] {
  const bytes = Buffer.from(data, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 100, 'utf8')
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write('00000000000\0', 136, 12)
  header.write('        ', 148, 8)
  header.write(typeflag, 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const pad = Buffer.alloc((512 - (bytes.length % 512)) % 512)
  return [header, bytes, pad]
}

const longName = `${'l'.repeat(120)}/deep.txt`
const tar = Buffer.concat([
  ...tarEntry('root/dir/', '', '5'),
  ...tarEntry('root/a.txt', 'alpha'),
  ...tarEntry('root/link', 'root/a.txt', '2'),
  ...tarEntry('__MACOSX/root/junk', 'junk'),
  ...tarEntry('root/./b.txt', 'beta'),
  ...tarEntry('././@LongLink', longName, 'L'),
  ...tarEntry('placeholder-will-be-overridden', 'deep content'),
  ...tarEntry('root/pax', '27 path=root/from-pax.txt\n', 'x'),
  ...tarEntry('placeholder-2', 'pax content'),
])
const extracted = extractTar(new Uint8Array(tar))
check('regular file extracted', extracted.get('root/a.txt')?.toString() === 'alpha')
check('directories and symlinks skipped', ![...extracted.keys()].some(path => path.endsWith('/') || path === 'root/link'))
check('__MACOSX junk dropped', ![...extracted.keys()].some(path => path.includes('__MACOSX')))
check("'./' segments normalize away", extracted.get('root/b.txt')?.toString() === 'beta')
check('GNU longname overrides the next header', extracted.get(longName) === undefined ? false : extracted.get(longName)?.toString() === 'deep content', [...extracted.keys()])
check('pax path override applies', extracted.get('root/from-pax.txt')?.toString() === 'pax content')
throws('traversal path rejected', () => extractTar(new Uint8Array(Buffer.concat([...tarEntry('root/../escape.txt', 'x')]))))

// ---- marketplace subtree download (injected fetcher) ----
const subtreeTar = gzipSync(new Uint8Array(Buffer.concat([
  ...tarEntry('repo-deadbeef/pkg/.claude-plugin/plugin.json', '{"name":"demo","version":"1.2.3"}'),
  ...tarEntry('repo-deadbeef/pkg/skills/demo/SKILL.md', '---\nname: demo\ndescription: d\n---\nbody'),
  ...tarEntry('repo-deadbeef/outside.txt', 'not part of the plugin'),
])))
const gitEntry: MarketEntry = {
  name: 'demo',
  source: { source: 'git-subdir', url: 'https://github.com/acme/repo.git', path: 'pkg', sha: 'deadbeef' },
}
const market1 = new CcMarket('/unused/market.json', async url => {
  if (url !== 'https://codeload.github.com/acme/repo/tar.gz/deadbeef') throw new Error(`unexpected url ${url}`)
  return subtreeTar
})
const fetched = await market1.fetchPluginFiles(gitEntry, 'market@pin-1')
check('git-subdir keeps only the subtree',
  [...fetched.files.keys()].sort().join('|') === '.claude-plugin/plugin.json|skills/demo/SKILL.md'
  && fetched.files.get('.claude-plugin/plugin.json')?.toString().includes('"demo"'), [...fetched.files.keys()])
check('git-subdir pin is the sha', fetched.pin === 'deadbeef')

const marketTarball = gzipSync(new Uint8Array(Buffer.concat([
  ...tarEntry('claude-plugins-official-main/plugins/tiny/.claude-plugin/plugin.json', '{"name":"tiny"}'),
  ...tarEntry('claude-plugins-official-main/external_plugins/other/x.txt', 'x'),
])))
const pathEntry: MarketEntry = { name: 'tiny', source: './plugins/tiny' }
const market2 = new CcMarket('/unused/market.json', async url => {
  if (url !== 'https://codeload.github.com/anthropics/claude-plugins-official/tar.gz/refs/heads/main') {
    throw new Error(`unexpected url ${url}`)
  }
  return marketTarball
})
const fetched2 = await market2.fetchPluginFiles(pathEntry, 'market@pin-2')
check('in-repo path source strips the tarball root and prefix',
  [...fetched2.files.keys()].join('|') === '.claude-plugin/plugin.json' && fetched2.pin === 'market@pin-2')

// ---- manifest mcpServers → converter → plain mount record ----
const manifestServers = {
  github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
  docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}' } },
}
const preview = convertMcpImport(JSON.stringify({ mcpServers: manifestServers }))
check('manifest mcpServers convert 1:1', preview.entries.length === 2 && preview.errors.length === 0, preview.errors)
const githubView = preview.entries.find(entry => entry.name === 'github')?.config
const githubPlain = githubView === undefined ? undefined : viewToPlain(githubView)
check('env reference rides as a !!js marker', (githubPlain?.env as Record<string, unknown>)?.GITHUB_TOKEN !== undefined
  && JSON.stringify((githubPlain?.env as Record<string, unknown>).GITHUB_TOKEN).includes('__jsExpr'), githubPlain?.env)
const docsView = preview.entries.find(entry => entry.name === 'docs')?.config
const docsPlain = docsView === undefined ? undefined : viewToPlain(docsView)
check('http header template rides as a !!js marker', JSON.stringify((docsPlain?.headers as Record<string, unknown>)?.Authorization).includes('process.env.DOCS_TOKEN'), docsPlain?.headers)

// ---- marketplace index parsing against the real snapshot ----
const root = dirname(fileURLToPath(import.meta.url))
const snapshotBytes = new Uint8Array(await readFile(join(root, 'market-remote.json')))
const entries = parseMarketIndex(snapshotBytes)
check('snapshot parses to 315 entries', entries.length === 315, entries.length)
const names = new Set(entries.map(entry => entry.name))
check('entry names are unique and present (chrome-devtools-mcp included)',
  names.size === entries.length && names.has('chrome-devtools-mcp') && names.has('frontend-design'))

// ---- refresh pin precision (HEAD sha via the API, timestamp fallback) ----
check('pin shapes: entry sha / market@HEAD are exact, timestamps are not',
  isExactPin('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  && isExactPin('market@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  && !isExactPin('market@2026-10-29T02:40:00.000Z'))

const indexJson = JSON.stringify({ plugins: [{ name: 'demo', source: './plugins/demo' }] })
const headJson = JSON.stringify({ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
const tempDir = await mkdtemp(join(tmpdir(), 'cc-market-'))
try {
  const withHead = new CcMarket(join(tempDir, 'a', 'market.json'), async url => {
    if (url.includes('api.github.com')) return new TextEncoder().encode(headJson)
    return new TextEncoder().encode(indexJson)
  })
  const pinned = await withHead.list(true)
  check('refresh pins the marketplace HEAD sha', pinned.pin === `market@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`, pinned.pin)

  const noHead = new CcMarket(join(tempDir, 'b', 'market.json'), async url => {
    if (url.includes('api.github.com')) throw new Error('rate limited')
    return new TextEncoder().encode(indexJson)
  })
  const fallback = await noHead.list(true)
  check('HEAD failure falls back to a timestamp pin', fallback.pin.startsWith('market@20') && !isExactPin(fallback.pin), fallback.pin)

  // a failed forced refresh serves the stale cache instead of erroring
  const once = new CcMarket(join(tempDir, 'c', 'market.json'), async url => {
    if (url.includes('api.github.com')) return new TextEncoder().encode(headJson)
    return new TextEncoder().encode(indexJson)
  })
  await once.list(true)
  const offline = new CcMarket(join(tempDir, 'c', 'market.json'), async () => { throw new Error('offline') })
  const stale = await offline.list(true)
  check('forced refresh offline serves the stale cache', stale.pin === pinned.pin && stale.entries.length === 1)
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${String(failures)} FAILURES`)
  process.exitCode = 1
} else {
  console.log('\nall m6 checks passed')
}

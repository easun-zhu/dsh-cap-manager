/**
 * M4 smoke probes (run with: node --experimental-strip-types test/m4-smoke.ts).
 * Verifies the import converter, the export inversion, and the skills
 * archive import/bundle round-trip without a running host.
 */
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { convertMcpImport, exportMcpEntry } from '../src/import-mcp.ts'
import { clearTrashItems, importSkillFiles, listTrashItems, readSkillBundle, removeSkillToTrash } from '../src/skills-store.ts'

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures += 1
    console.log(`FAIL - ${label}`, detail ?? '')
  }
}

// ---- import converter ----
const doc = `{
  // VS Code style comment
  "inputs": [{ "id": "key", "type": "promptString", "description": "API key", "password": true }],
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer \${env:DOCS_TOKEN}" } },
    "legacy-sse": { "type": "sse", "url": "https://old.example.com/sse" },
    "My Server.Foo": { "command": "uvx", "args": ["mcp-server-fetch"] },
    "needs-input": { "command": "npx", "args": ["-y", "x"], "env": { "KEY": "\${input:key}" } },
    "broken": { "foo": 1 },
  }
}`
const preview = convertMcpImport(doc)
const byName = new Map(preview.entries.map(entry => [entry.name, entry]))
check('5 entries converted, 1 error', preview.entries.length === 5 && preview.errors.length === 1, preview.errors)
const github = byName.get('github')
check('stdio env ref → !!js process.env', github?.config.env?.GITHUB_TOKEN === '!!js process.env.GITHUB_TOKEN', github?.config)
const docs = byName.get('docs')
check('embedded env ref → backtick template',
  docs?.config.headers?.Authorization === '!!js `Bearer ${process.env.DOCS_TOKEN}`', docs?.config)
check('sse maps to streamable-http with warning',
  byName.get('legacy-sse')?.transport === 'streamable-http'
  && (byName.get('legacy-sse')?.warnings.length ?? 0) === 1)
const renamed = preview.entries.find(entry => entry.originalName === 'My Server.Foo')
check('invalid key slugged + renamed flag', renamed?.name === 'my-server-foo' && renamed.renamed === true, renamed)
const needsInput = byName.get('needs-input')
check('${input:} collected for the form', needsInput?.inputs.length === 1 && needsInput.inputs[0].password === true, needsInput?.inputs)
check('jsonc tolerated (comment + trailing comma)', true)

// ---- export inversion ----
const exportedStdio = exportMcpEntry({
  transport: 'stdio',
  serverName: 'x',
  command: 'npx',
  args: ['-y', 'pkg'],
  env: { TOKEN: { __jsExpr: 'process.env.TOKEN' } },
})
check('export stdio keeps command/args, env ref → ${TOKEN}',
  JSON.stringify(exportedStdio) === '{"command":"npx","args":["-y","pkg"],"env":{"TOKEN":"${TOKEN}"}}', exportedStdio)
const exportedHttp = exportMcpEntry({
  transport: 'streamable-http',
  serverName: 'y',
  url: { __jsExpr: '`https://${process.env.HOST}/mcp`' },
  headers: { Authorization: { __jsExpr: '`Bearer ${process.env.T}`' } },
})
check('export http templates fold back to ${…} holes',
  JSON.stringify(exportedHttp) === '{"type":"http","url":"https://${HOST}/mcp","headers":{"Authorization":"Bearer ${T}"}}', exportedHttp)

// ---- skills archive import + bundle round-trip ----
const root = await mkdtemp(join(tmpdir(), 'cap-m4-'))
const skillMd = '---\r\nname: demo-imported\r\ndescription: smoke skill\r\nwhenToUse: testing\r\n---\r\n\r\nBody line.\r\n'
const outcome = await importSkillFiles(root, [
  { path: 'wrapper/demo-imported/SKILL.md', base64: Buffer.from(skillMd).toString('base64') },
  { path: 'wrapper/demo-imported/assets/helper.txt', base64: Buffer.from('asset').toString('base64') },
  { path: '__MACOSX/junk', base64: Buffer.from('junk').toString('base64') },
  { path: 'bad-dir/README.md', base64: Buffer.from('no skill').toString('base64') },
], false)
check('one imported, one skipped (missing SKILL.md)',
  outcome.imported.length === 1 && outcome.imported[0].name === 'demo-imported'
  && outcome.skipped.length === 1 && outcome.skipped[0].path === 'bad-dir', outcome)
const written = await readFile(join(root, 'demo-imported', 'SKILL.md'), 'utf8')
check('CRLF preserved verbatim (author content survives)', written === skillMd, JSON.stringify(written))
const bundle = await readSkillBundle(join(root, 'demo-imported', 'SKILL.md'))
check('bundle walks dir with SKILL.md first + asset',
  bundle.files.length === 2 && bundle.files[0].path === 'SKILL.md' && bundle.files[1].path === 'assets/helper.txt', bundle.files)
const again = await importSkillFiles(root, [
  { path: 'demo-imported/SKILL.md', base64: Buffer.from(skillMd).toString('base64') },
], false)
check('same-name second import skipped without overwrite',
  again.skipped.length === 1 && again.skipped[0].reason.includes('already exists'), again)
const overwrite = await importSkillFiles(root, [
  { path: 'demo-imported/SKILL.md', base64: Buffer.from(skillMd).toString('base64') },
], true)
check('overwrite replaces', overwrite.imported.length === 1, overwrite)
let escapeCaught = false
try {
  await importSkillFiles(root, [{ path: '../outside.md', base64: Buffer.from('x').toString('base64') }], false)
} catch {
  escapeCaught = true
}
check('path traversal rejected', escapeCaught)
check('empty trash lists as []', (await listTrashItems(join(root, 'no-trash'))).length === 0)
// clearTrash empties every item in one call (create two via removeSkillToTrash first)
const trashBase = join(root, 'trash')
for (const dir of ['skill-src', 'skill-src-2']) {
  const file = join(root, dir, 'SKILL.md')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, skillMd)
  await removeSkillToTrash(file, trashBase)
}
check('two trashed skills list', (await listTrashItems(trashBase)).length === 2)
check('clearTrashItems removes all and reports the count', await clearTrashItems(trashBase) === 2)
check('trash empty after clear', (await listTrashItems(trashBase)).length === 0)
check('clearing an empty trash reports zero', await clearTrashItems(trashBase) === 0)
await rm(root, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall M4 smoke checks passed')

/**
 * Build the browser half into the client-module registration contract:
 *
 *   window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     …CJS bundle body (platform externals resolved through `require`)…
 *     return module.exports;
 *   } });
 *
 * The wrapper shape is the out-of-repo reproduction of the in-repo tsdown
 * `clientBundle` preset (packages/client/tsdown.client.ts); the runtime only
 * cares about this registration call (packages/client/modules manifest.ts).
 * The build fails loudly if the artifact no longer matches the contract.
 */
import { readFileSync } from 'node:fs'
import esbuild from 'esbuild'

const PKG = 'dsh-cap-manager'

/** Platform-shared modules served from the boot seed table — never bundled. */
const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

await esbuild.build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  external: EXTERNAL,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})

const text = readFileSync('lib/client.js', 'utf8')
const head = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => {`
if (!text.startsWith(head)) throw new Error(`client bundle contract: banner mismatch — expected ${head}`)
if (!text.trimEnd().endsWith('return module.exports; } });')) throw new Error('client bundle contract: footer mismatch')
console.log(`client bundle contract OK: lib/client.js (${text.length} bytes)`)

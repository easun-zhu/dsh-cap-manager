/**
 * Build the Host half: src/index.ts → lib/index.js as ESM with every package
 * import kept external (harness packages resolve to the running dsh's copies
 * through the profile's runtime resolution).
 */
import esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
})

console.log('host bundle: lib/index.js')

/**
 * Browser half of dsh-film-studio, built the way DeepSeek Harness loads an
 * external package's client: a closure-factory file that calls
 * `window.__ModuleLoader__.load({ id, factory })` and gets React and the client
 * primitives through the injected `require` (the Host's module table).
 *
 * One entry, no chunks: the workbench lives in a frame, so the client half is
 * small and has nothing to load lazily.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const id = 'dsh-film-studio'

/** The package version, compiled into the bundle for diagnostics. */
const packageVersion = (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version

/** Modules the Host's module table provides; a `require` it cannot answer throws at load. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  dts: false,
  sourcemap: false,
  clean: true,
  deps: {
    neverBundle: (source: string) => CLIENT_EXTERNALS.includes(source),
    // Everything the module table does not answer must be inlined.
    alwaysBundle: (source: string) => !CLIENT_EXTERNALS.includes(source),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __DSH_FILM_STUDIO_VERSION__: JSON.stringify(packageVersion),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

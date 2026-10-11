/**
 * Host half of dsh-film-studio, bundled into one self-contained file.
 *
 * The Host may install this plugin by linking a directory (`link:` in pnpm), in
 * which case the plugin has no `node_modules` of its own and a bare `import` of a
 * peer fails the whole entry (`ERR_MODULE_NOT_FOUND`, reported as "failed to
 * import"). Everything except Node's own modules is therefore inlined here; the
 * peers stay declared in package.json as metadata, not as a load-time need.
 *
 * `defineTool` and the schema helper are pure functions over plain objects (no
 * cross-package identity), so an inlined copy behaves the same.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  tsconfig: 'tsconfig.json',
  // Declarations come from `tsc --emitDeclarationOnly` (tsdown's dts naming does
  // not follow entryFileNames here and would ship a stray lib/index.ts).
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: (source: string) => source.startsWith('node:'),
    alwaysBundle: (source: string) => !source.startsWith('node:'),
  },
  outputOptions: { entryFileNames: 'index.js' },
})

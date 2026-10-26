// Bundles the Storefront Manager as one browser IIFE (window.RackdStorefront) so Electron apps and the static
// manage site can load it without a React toolchain of their own.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/mount.tsx'],
  outfile: 'dist/storefront-admin.js',
  bundle: true,
  format: 'iife',
  globalName: 'RackdStorefront',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  sourcemap: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

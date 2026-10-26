// Static build for manage.r4ckd.net: bundles the app (and the shared Storefront Manager module) into dist/.
import { createRequire } from 'node:module';
const { build } = createRequire(import.meta.url)('../packages/storefront-admin/node_modules/esbuild');
import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../packages/storefront-admin');
mkdirSync(resolve(here, 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(here, 'src/main.tsx')],
  outfile: resolve(here, 'dist/app.js'),
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome110'], minify: true, sourcemap: true, jsx: 'automatic',
  alias: { '@sfm': resolve(pkg, 'src') },
  nodePaths: [resolve(pkg, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
execSync(`npx tailwindcss -c tailwind.config.cjs -i src/styles.css -o "${resolve(here, 'dist/app.css')}" --minify`, { cwd: pkg, stdio: 'inherit' });
cpSync(resolve(here, 'index.html'), resolve(here, 'dist/index.html'));
cpSync(resolve(here, '_headers'), resolve(here, 'dist/_headers'));
if (!existsSync(resolve(here, 'dist/config.js'))) {
  const src = existsSync(resolve(here, 'config.js')) ? 'config.js' : 'config.example.js';
  writeFileSync(resolve(here, 'dist/config.js'), readFileSync(resolve(here, src)));
}

/*
 * Copies shared-ui/kit.css + shared-ui/kit.js (the fleet-wide skeleton /
 * tooltip / session-cache / optimistic-UI helpers) into each Electron app's
 * own renderer folder as shared-ui-kit.css / shared-ui-kit.js.
 *
 * Why copies instead of one shared reference: manager-portal and
 * owner-console are packaged as SEPARATE electron-builder apps whose
 * package.json "files" list only includes their own renderer/**\/* — a file
 * living outside that folder (e.g. at the repo root) would never be included
 * in their installers, only work in dev. shared-ui/ is the single source of
 * truth; this script is how the three copies stay identical to it. Run via
 * `npm run sync:ui`, or automatically as part of `build` / `dev` / `start` /
 * `release:all` (see package.json + release-all.js).
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SRC = {
  css: path.join(root, 'shared-ui', 'kit.css'),
  js: path.join(root, 'shared-ui', 'kit.js'),
};
const TARGETS = [
  path.join(root, 'src', 'renderer'),
  path.join(root, 'manager-portal', 'renderer'),
  path.join(root, 'owner-console', 'renderer'),
];

const banner =
  '/* AUTO-GENERATED — do not edit directly. Source: shared-ui/{FILE} — ' +
  'run `npm run sync:ui` after changing it there. */\n';

for (const dir of TARGETS) {
  if (!fs.existsSync(dir)) {
    console.warn(`skip (missing): ${dir}`);
    continue;
  }
  const css = banner.replace('{FILE}', 'kit.css') + fs.readFileSync(SRC.css, 'utf8');
  const js = banner.replace('{FILE}', 'kit.js') + fs.readFileSync(SRC.js, 'utf8');
  fs.writeFileSync(path.join(dir, 'shared-ui-kit.css'), css);
  fs.writeFileSync(path.join(dir, 'shared-ui-kit.js'), js);
  console.log(`synced -> ${path.relative(root, dir)}`);
}

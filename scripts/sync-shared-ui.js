
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

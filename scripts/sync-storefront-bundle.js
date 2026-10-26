// Builds packages/storefront-admin (if needed) and copies the browser bundle into the Electron apps that mount it.
// Runs before electron-builder (see "predist" in owner-console and manager-portal). The copies are git-ignored.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = path.join(__dirname, '..', 'packages', 'storefront-admin');
const dist = path.join(pkg, 'dist');
const files = ['storefront-admin.js', 'storefront-admin.css'];

if (process.argv.includes('--build') || !files.every((f) => fs.existsSync(path.join(dist, f)))) {
  if (!fs.existsSync(path.join(pkg, 'node_modules'))) execSync('npm install --no-audit --no-fund', { cwd: pkg, stdio: 'inherit' });
  execSync('npm run build', { cwd: pkg, stdio: 'inherit' });
}
for (const app of ['owner-console', 'manager-portal']) {
  const out = path.join(__dirname, '..', app, 'renderer', 'vendor');
  fs.mkdirSync(out, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(dist, f), path.join(out, f));
  console.log(`storefront bundle -> ${path.relative(path.join(__dirname, '..'), out)}`);
}

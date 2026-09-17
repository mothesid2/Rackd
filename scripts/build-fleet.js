
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const arg = (process.argv[2] || 'demo').toLowerCase();
const variants = arg === 'all' ? ['prod', 'demo'] : [arg === 'prod' ? 'prod' : 'demo'];


const APPS = [
  ['.', true],                 
  ['manager-portal', false],
  ['owner-console', false],
  ['storefront-desktop', false],
];

const root = path.resolve(__dirname, '..');
function run(cmd, args, cwd = root) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

for (const variant of variants) {
  for (const [appDir, needsTs] of APPS) {
    const dir = path.join(root, appDir);
    if (!fs.existsSync(path.join(dir, 'package.json'))) { console.warn(`skip ${appDir} (not found)`); continue; }
    if (!fs.existsSync(path.join(dir, 'node_modules'))) { console.warn(`skip ${appDir} — run "npm install" in it first`); continue; }
    if (needsTs) run('npm', ['run', 'build:main']);
    run('node', [path.join('scripts', 'build-desktop.js'), appDir, variant]);
  }
}
console.log('\nFleet build complete. Installers are in each app\'s output dir (release/ or dist/).');

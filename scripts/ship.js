
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APPS = {
  pos:     { dir: '.',               releaseDir: 'release',                appId: 'pos',     ts: true },
  manager: { dir: 'manager-portal',  releaseDir: 'manager-portal/dist',    appId: 'manager', ts: false },
  owner:   { dir: 'owner-console',   releaseDir: 'owner-console/dist',     appId: 'owner',   ts: false },
};

const args = process.argv.slice(2);
const production = args.includes('--production');
const appKey = args.find((a) => !a.startsWith('--')) || 'pos';
const app = APPS[appKey];
if (!app) { console.error(`Unknown app '${appKey}'. Use one of: ${Object.keys(APPS).join(', ')}`); process.exit(1); }

const root = path.resolve(__dirname, '..');
const channel = production ? 'production' : 'staging';
function run(cmd, a, cwd = root) {
  console.log(`\n$ ${cmd} ${a.join(' ')}`);
  execFileSync(cmd, a, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}


const pkgPath = path.join(root, app.dir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = String(pkg.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
const next = `${maj}.${min}.${pat + 1}`;
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n${appKey}: ${maj}.${min}.${pat} → ${next}`);


if (app.ts) run('npm', ['run', 'build:main']);
run('node', [path.join('scripts', 'build-desktop.js'), app.dir, 'prod']);


run('node', [path.join('scripts', 'publish-update.js'), channel, app.appId, app.releaseDir]);

console.log(`\n✅ ${appKey} ${next} is on the '${channel}' channel.`);
console.log(production
  ? '   Live kiosks will auto-update on their next launch.'
  : '   Now open the Owner Console → Publish updates → Publish to roll it out to production.');

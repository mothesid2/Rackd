/*
 * One-shot "ship an update" for the Rackd fleet.
 *
 *   node scripts/ship.js [app] [--production]
 *
 * Does the three things that must happen together, in order, so an update can
 * never silently fail to roll out:
 *   1) BUMP the patch version (electron-updater only upgrades to a higher version),
 *   2) BUILD the production installer,
 *   3) UPLOAD it to the STAGING channel (or production with --production).
 *
 * Then you just open the Owner Console → Publish updates → Publish, and every
 * installed kiosk auto-updates on its next launch. No installers, no store visits.
 *
 *   npm run ship                    # POS → staging  (default; then Publish in the console)
 *   npm run ship -- --production     # POS → straight to production (skips the review step)
 *   node scripts/ship.js owner       # Owner Console → staging
 *   node scripts/ship.js manager     # Manager Portal → staging
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (this machine only).
 */
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

// 1) bump patch version
const pkgPath = path.join(root, app.dir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = String(pkg.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
const next = `${maj}.${min}.${pat + 1}`;
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n${appKey}: ${maj}.${min}.${pat} → ${next}`);

// 2) build installer (POS main is TypeScript → compile first)
if (app.ts) run('npm', ['run', 'build:main']);
run('node', [path.join('scripts', 'build-desktop.js'), app.dir, 'prod']);

// 3) upload to the channel
run('node', [path.join('scripts', 'publish-update.js'), channel, app.appId, app.releaseDir]);

console.log(`\n✅ ${appKey} ${next} is on the '${channel}' channel.`);
console.log(production
  ? '   Live kiosks will auto-update on their next launch.'
  : '   Now open the Owner Console → Publish updates → Publish to roll it out to production.');

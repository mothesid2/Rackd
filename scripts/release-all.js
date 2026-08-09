/*
 * One-click full release: git push, then version-bump + build + publish-to-
 * PRODUCTION for all three desktop apps (POS, Manager Portal, Owner Console)
 * in one run. This is the direct-to-production path (same as running
 * `npm run release` in each app folder) — NOT the staging+Owner-Console-Publish
 * flow that scripts/ship.js uses. Use this when you want every installed app
 * to pick up the update on its next launch, no separate promote step.
 *
 *   node scripts/release-all.js
 *   npm run release:all
 *
 * Double-click scripts/release-all.bat to run this without opening a terminal
 * yourself — it keeps the window open afterward so you can read the summary
 * (or any error) before it closes.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (this machine only,
 * same as ship.js / publish-update.js).
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
// stdio: 'inherit' streams live but Node never captures it, so execFileSync's
// thrown error has stdout/stderr === null on failure — exactly the useless
// "output: [ null, null, null ]" a failed release produced with no way to see
// what actually broke. Capture instead: print the child's output ourselves
// (so a normal run still shows everything), and on failure the real
// stdout/stderr are printed explicitly before rethrowing, not lost.
function run(cmd, args, cwd = root) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  try {
    const output = execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
    if (output) process.stdout.write(output);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    console.error(`\n✗ FAILED: ${cmd} ${args.join(' ')}`);
    throw e;
  }
}

// ── 1) git push — best-effort. A clean "nothing to push" or a real failure
// (no upstream, merge conflict, needs credentials) is reported but does NOT
// stop the release — the build/publish steps below don't depend on git state,
// and you may be intentionally re-releasing the same committed code.
console.log('── git push ──────────────────────────────────────────────');
try {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).toString().trim();
  run('git', ['push', 'origin', branch]);
} catch (e) {
  console.warn(`\n⚠ git push did not complete cleanly (${e.message.split('\n')[0]}). Continuing with the release anyway — push manually if this needs your credentials or a conflict resolved.`);
}

// ── 2) bump + build + publish each app straight to production ──────────────
const APPS = [
  { key: 'pos',     dir: '.',              releaseDir: 'release',              appId: 'pos',     ts: true },
  { key: 'manager', dir: 'manager-portal', releaseDir: 'manager-portal/dist',  appId: 'manager', ts: false },
  { key: 'owner',   dir: 'owner-console',  releaseDir: 'owner-console/dist',   appId: 'owner',   ts: false },
];

const results = [];
for (const app of APPS) {
  console.log(`\n── ${app.key} ─────────────────────────────────────────────`);
  const pkgPath = path.join(root, app.dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const [maj, min, pat] = String(pkg.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const next = `${maj}.${min}.${pat + 1}`;
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${app.key}: ${maj}.${min}.${pat} → ${next}`);

  if (app.ts) run('npm', ['run', 'build:main']);
  run('node', [path.join('scripts', 'build-desktop.js'), app.dir, 'prod']);
  run('node', [path.join('scripts', 'publish-update.js'), 'production', app.appId, app.releaseDir]);
  results.push({ app: app.key, version: next });
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('Released to production:');
for (const r of results) console.log(`  ${r.app.padEnd(8)} ${r.version}`);
console.log('\nInstalled apps on the production channel will update on their next launch.');

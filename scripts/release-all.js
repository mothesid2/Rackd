
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');

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


console.log('── git push ──────────────────────────────────────────────');
try {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).toString().trim();
  run('git', ['push', 'origin', branch]);
} catch (e) {
  console.warn(`\n⚠ git push did not complete cleanly (${e.message.split('\n')[0]}). Continuing with the release anyway — push manually if this needs your credentials or a conflict resolved.`);
}


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

/*
 * Publish the current build to a Supabase Storage channel so installed apps
 * auto-update. Uploads latest.yml + the .exe + .blockmap to app-updates/<channel>/.
 *
 *   node scripts/publish-update.js staging      (your test machine's channel)
 *   node scripts/publish-update.js production    (customers)
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (owner machine only;
 * the service-role key is never shipped in the app).
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// minimal .env loader — always the ROOT .env (this script's own directory is
// <root>/scripts, so this resolves correctly no matter which app folder you run
// `npm run release:staging` from). manager-portal/ and owner-console/ have no
// .env of their own by design (one set of cloud credentials, not three copies to
// keep in sync) — reading based on process.cwd() silently found nothing there.
const ROOT_ENV = path.join(__dirname, '..', '.env');
for (const line of (fs.existsSync(ROOT_ENV) ? fs.readFileSync(ROOT_ENV, 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const BUCKET = 'app-updates';
const channel = process.argv[2] === 'staging' ? 'staging' : 'production';
// Per-app channel layout: app-updates/<app>/<channel>/. Defaults to the POS.
const APP = process.argv[3] || 'pos';
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env — cannot publish.');
  process.exit(1);
}

// Release dir (argv[4]) — POS builds to release/, the portal/owner apps to dist/.
const releaseDir = process.argv[4] || 'release';
if (!fs.existsSync(path.join(releaseDir, 'latest.yml'))) {
  console.error(`No ${releaseDir}/latest.yml — build first.`);
  process.exit(1);
}

// Only publish the CURRENT version's files (the installer named in latest.yml),
// not stale installers left over from previous builds.
const yml = fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8');
const exe = (yml.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
const files = ['latest.yml'];
if (exe && fs.existsSync(path.join(releaseDir, exe))) {
  files.push(exe);
  if (fs.existsSync(path.join(releaseDir, exe + '.blockmap'))) files.push(exe + '.blockmap');
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

(async () => {
  console.log(`Publishing ${files.length} file(s) to '${channel}' channel…`);
  for (const f of files) {
    const body = fs.readFileSync(path.join(releaseDir, f));
    const dest = `${APP}/${channel}/${f}`;
    const contentType = f.endsWith('.yml') ? 'text/yaml' : f.endsWith('.exe') ? 'application/octet-stream' : 'application/octet-stream';
    const { error } = await sb.storage.from(BUCKET).upload(dest, body, { upsert: true, contentType });
    if (error) {
      console.error(`  FAILED ${dest}: ${error.message}`);
      if (/bucket/i.test(error.message)) console.error(`  (create a PUBLIC bucket named "${BUCKET}" in Supabase Storage first)`);
      process.exit(1);
    }
    console.log(`  ✓ ${dest}  (${(body.length / 1048576).toFixed(1)} MB)`);
  }
  console.log(`\nDone. '${channel}' channel now serves this build. Installed apps on that channel will update on next launch.`);
  process.exit(0);
})();

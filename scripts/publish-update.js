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

// minimal .env loader
for (const line of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const BUCKET = 'app-updates';
const channel = process.argv[2] === 'staging' ? 'staging' : 'production';
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env — cannot publish.');
  process.exit(1);
}

const releaseDir = 'release';
if (!fs.existsSync(path.join(releaseDir, 'latest.yml'))) {
  console.error('No release/latest.yml — run "npm run build" first.');
  process.exit(1);
}

const files = fs.readdirSync(releaseDir).filter(
  (f) => f === 'latest.yml' || f.endsWith('.exe') || f.endsWith('.blockmap')
);

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

(async () => {
  console.log(`Publishing ${files.length} file(s) to '${channel}' channel…`);
  for (const f of files) {
    const body = fs.readFileSync(path.join(releaseDir, f));
    const dest = `${channel}/${f}`;
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

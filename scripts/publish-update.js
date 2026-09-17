
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');


const ROOT_ENV = path.join(__dirname, '..', '.env');
for (const line of (fs.existsSync(ROOT_ENV) ? fs.readFileSync(ROOT_ENV, 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const BUCKET = 'app-updates';
const channel = process.argv[2] === 'staging' ? 'staging' : 'production';

const APP = process.argv[3] || 'pos';
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env — cannot publish.');
  process.exit(1);
}


const releaseDir = process.argv[4] || 'release';
if (!fs.existsSync(path.join(releaseDir, 'latest.yml'))) {
  console.error(`No ${releaseDir}/latest.yml — build first.`);
  process.exit(1);
}


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

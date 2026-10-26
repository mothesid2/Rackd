// Builds the static export wired to the local mock server (see mock-server.mjs).
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:3111/sb',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  },
});
process.exit(r.status ?? 1);

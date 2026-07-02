# Supabase deploy runbook

The app code is complete and dormant until the cloud side is provisioned. These
steps must be run by someone with **owner access to the Supabase project** (they
need the service-role key + JWT secret, which are not in this repo).

## 1. Deploy the cloud schema
Run the migrations in `supabase/migrations/` (order matters — `001` defines the
shared helpers). Either:

- **Dashboard:** SQL Editor → paste each `NNN_*.sql` in order → Run, **or**
- **CLI:** `supabase db push` (with the project linked).

Creates `licenses`, the `*_cloud` mirror tables, `scan_data_queue`,
`sms_campaigns`, `settings_backup`, `conflicts` — all with RLS + `updated_at`
triggers.

## 2. Seed a test license
```sql
insert into public.licenses (license_key, tenant_id, active, tier, features)
values ('RACKD-TEST-0001', gen_random_uuid(), true, 'pro', array['sms','rebates']);
```
Note the `license_key` and put it in `.env` as `TEST_LICENSE_KEY`.

## 3. Deploy the jwt-issuer Edge Function
```bash
supabase secrets set SUPABASE_JWT_SECRET=<project JWT secret>   # Settings → API → JWT Settings
supabase functions deploy jwt-issuer
```
(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into deployed
functions automatically.)

## 4. Fill local `.env` (gitignored)
```
SUPABASE_URL=...            # already set
SUPABASE_ANON_KEY=...       # already set
SUPABASE_SERVICE_ROLE_KEY=  # for local admin scripts only; never ships to the client
SUPABASE_JWT_SECRET=        # local reference
TEST_LICENSE_KEY=RACKD-TEST-0001
```

## 5. Verify end-to-end
```bash
npx tsc scripts/auth-demo.ts --outDir .tmp --module commonjs --target ES2020 --esModuleInterop --skipLibCheck
node .tmp/auth-demo.js
```
Expected: token issued → read own license row PASS → cross-tenant insert BLOCKED
→ foreign-tenant read returns 0 rows. That confirms RLS is enforced end-to-end.

## Notes
- The desktop client only ever uses the **anon key**; it authenticates per-install
  via the JWT minted by `jwt-issuer` (never the service-role key).
- Until this is done, the app runs fully local (license policy: a never-licensed
  install is unenforced, so it is not blocked).

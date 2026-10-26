# Permit expiry reminders

Owners get an email 30 days and again 7 days before any permit expires (email only; no SMS is involved).

## How it works

- Permits are copied into `business_permits` when an application is approved.
- `permits_due_for_notice()` (migration 086) lists permits expiring in 8-30 days (the "30" reminder) or 0-7 days
  (the "7" reminder) that have not been reminded yet. `permit_notices` remembers what was sent, once per permit,
  bucket and expiry date, so a renewed permit (new expiry date) gets fresh reminders.
- `POST /api/cron/permit-reminders` sends one email per owner per bucket listing every permit that is due, then records each
  permit. An email that fails to send is not recorded, so the next run retries it. Safe to run more than once a day.
- Each run writes a `permit_reminders.run` row to the audit log with the counts.

## Configure

Cloudflare Pages secrets: `CRON_SECRET` (long random string), plus the existing `RESEND_API_KEY`, `SUPABASE_*`.
Without `CRON_SECRET` the endpoint refuses to run (503); it is never open by default.

Test it by hand:

```bash
curl -X POST https://r4ckd.net/api/cron/permit-reminders -H "Authorization: Bearer $CRON_SECRET"
# {"ok":true,"due":3,"emails_sent":2,"emails_failed":0,"permits_marked":3}
```

## Schedule it (pick one)

Cloudflare Pages has no cron triggers, so an external scheduler calls the endpoint once a day.

**A. Supabase Cron (pg_cron + pg_net)**, in the SQL editor (enable the `pg_cron` and `pg_net` extensions first):

```sql
-- store the secret once so it is not visible in the job text
select vault.create_secret('<your CRON_SECRET>', 'permit_cron_secret');

select cron.schedule(
  'permit-reminders-daily',
  '0 14 * * *',            -- 14:00 UTC = 9:00 AM Central
  $$
  select net.http_post(
    url     := 'https://r4ckd.net/api/cron/permit-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'permit_cron_secret'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb
  );
  $$
);
```

**B. GitHub Actions** (`.github/workflows/permit-reminders.yml`), with `CRON_SECRET` as a repository secret:

```yaml
name: permit-reminders
on:
  schedule: [{ cron: '0 14 * * *' }]
  workflow_dispatch: {}
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: curl --fail-with-body -X POST https://r4ckd.net/api/cron/permit-reminders -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

## Known gap

There is no screen yet for an owner (or an admin) to enter a renewed permit's new expiry date, so reminders keep
following the dates captured at approval. Until that exists, update `business_permits.expiry` by hand when a renewal
certificate arrives.

## Owner activation status

`staff-login` now also calls `onb_mark_activated` after a successful owner (role `admin`) sign-in, best effort and
idempotent. The application already becomes `activated` when the owner finishes the password page, so whichever
happens first wins. The `staff-login` change takes effect only after you redeploy it:
`supabase functions deploy staff-login`.

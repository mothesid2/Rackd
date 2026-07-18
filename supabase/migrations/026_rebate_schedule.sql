-- 026_rebate_schedule.sql
-- Part 4 wiring: read SFTP secrets from Vault, seed manufacturers per tenant, and
-- schedule the weekly submission dispatch via pg_cron → the rebate-submit function.

-- ── service-role Vault reader (edge function calls this via RPC) ────────────
-- The SFTP password/key is stored in Supabase Vault; this SECURITY DEFINER
-- function returns it by id and is executable ONLY by the service role.
create or replace function public.rebate_get_secret(p_id uuid)
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_id;
$$;
revoke all on function public.rebate_get_secret(uuid) from public, anon, authenticated;
grant execute on function public.rebate_get_secret(uuid) to service_role;

-- ── seed each tenant's manufacturers (same fixed uids as the local seed) ────
-- So rebate_rules.manufacturer_uid joins, and the dispatcher knows each cadence.
-- Altria: batch ends Sat(6), due Tue(2). RJR: ends Sun(0), due Wed(3). ITG: TBD.
insert into public.manufacturers_cloud (uid, tenant_id, name, parent_company_code, batch_end_dow, due_dow, due_offset_weeks, timezone)
select v.uid::uuid, t.tenant_id, v.name, v.code, v.bed, v.dd, 1, 'America/Chicago'
from (select distinct tenant_id from public.licenses where tenant_id is not null) t
cross join (values
  ('a1000000-0000-4000-8000-000000000001', 'Altria',      'PM',   6,    2),
  ('a1000000-0000-4000-8000-000000000002', 'RJ Reynolds', 'RJRT', 0,    3),
  ('a1000000-0000-4000-8000-000000000003', 'ITG Brands',  'ITG',  null, null)
) as v(uid, name, code, bed, dd)
on conflict (tenant_id, uid) do nothing;

-- ── weekly dispatch via pg_cron (daily; the function only submits what's due) ─
-- Requires pg_cron + pg_net (enable in Dashboard → Database → Extensions) and two
-- Vault secrets the operator creates once:
--   rebate_function_url    = https://<ref>.supabase.co/functions/v1/rebate-submit
--   rebate_dispatch_secret = the REBATE_DISPATCH_SECRET set on the function
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    begin perform cron.unschedule('rebate-daily-dispatch'); exception when others then null; end;
    perform cron.schedule('rebate-daily-dispatch', '0 12 * * *', $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'rebate_function_url'),
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rebate_dispatch_secret'),
          'mode', 'dispatch'
        )
      );
    $cron$);
    raise notice 'Scheduled rebate-daily-dispatch (12:00 UTC daily).';
  else
    raise notice 'pg_cron/pg_net not enabled — enable them, create the two Vault secrets, then re-run this DO block to activate weekly submission.';
  end if;
end $$;

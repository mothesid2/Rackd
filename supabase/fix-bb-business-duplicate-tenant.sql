-- fix-bb-business-duplicate-tenant.sql
--
-- Removes a duplicate "BB Business LLC" TENANT (not just a duplicate location
-- row — this is a second, entirely separate license_key + tenant_id + location,
-- coincidentally sharing the same names). Verified live 2026-07-24:
--
--   KEEP  tenant 3715dedb-4923-46c3-b935-7b052ed9bee7  (created 2026-07-19)
--         - license RACKD-QSM9-PH5E-VPCK
--         - 3 real employees (admin, Tammy the cashier, a leftover test manager)
--         - 1 real kiosk actively checking in (last seen 2026-07-24)
--         - location "Stay Express Inn", 716 E Tyler St Athens TX 75751
--
--   DELETE tenant a561c1bc-4bdd-4f0f-aba3-775fb6608289  (created TODAY 21:54 UTC)
--         - license RACKD-DVV9-W5YF-PZX7
--         - 1 auto-generated admin only (username "sysadmin"), no real staff
--         - ZERO kiosk registrations, ZERO transactions, ZERO online orders
--         - location "Stay Express Inn" with no address/tax ever set — never
--           actually used for anything
--
-- This is safe: the tenant being deleted has no real usage of any kind.
--
-- ── STEP 1 — read-only sanity check before deleting (run this first) ────────
select 'employees' as what, count(*) from public.employees_cloud where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289'
union all
select 'kiosks', count(*) from public.license_registrations where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289'
union all
select 'transactions', count(*) from public.transactions_cloud where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289'
union all
select 'online_orders', count(*) from public.online_orders where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';
-- Expect: employees=1 (sysadmin only), everything else 0. If any of these
-- numbers looks different from that, STOP and don't run Step 2 — something
-- changed since this was written and it needs a fresh look.

-- ── STEP 2 — delete the duplicate tenant, in FK-safe order ──────────────────
begin;

delete from public.employees_cloud   where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';
delete from public.locations         where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';
delete from public.licenses          where tenant_id = 'a561c1bc-4bdd-4f0f-aba3-775fb6608289';

commit;

-- ── STEP 3 — verify only the real business remains ───────────────────────────
select id, name, license_key, tenant_id, kind from public.licenses where name = 'BB Business LLC';
-- Expect: exactly one row, tenant_id = 3715dedb-4923-46c3-b935-7b052ed9bee7.

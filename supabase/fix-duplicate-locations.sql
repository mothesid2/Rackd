-- fix-duplicate-locations.sql — one-time cleanup for the "store appears twice in
-- the Manager Portal" bug.
--
-- ROOT CAUSE: the Owner Console's "Create business" / "+ Location" buttons had no
-- double-submit guard, so a slow network response + a second click could fire the
-- create action twice, inserting two `locations` rows with the same tenant_id +
-- name. That UI bug is now fixed (owner-console/renderer/console.js disables the
-- button and shows a busy label while the request is in flight), which prevents
-- NEW duplicates — but it does not remove a duplicate that already exists.
--
-- This script does NOT run automatically. Read it, run STEP 1, confirm the
-- duplicate you expect to see, then run STEP 2 for that specific tenant_id/name.
-- It only touches your own project — paste into the Supabase SQL Editor.

-- ── STEP 1 — find duplicates (read-only) ─────────────────────────────────────
select tenant_id, name, count(*) as copies, array_agg(id order by created_at) as location_ids
  from public.locations
 group by tenant_id, name
having count(*) > 1;

-- ── STEP 2 — merge one duplicate pair, keeping the OLDEST row ────────────────
-- Fill in the tenant_id + name you found above, then run this whole block. It
-- keeps the earliest-created location row and re-points every table that
-- references the newer duplicate(s) onto it before deleting them, inside one
-- transaction (rolls back cleanly if anything fails).
--
-- begin;
-- do $$
-- declare
--   v_tenant uuid := '00000000-0000-0000-0000-000000000000';  -- <-- fill in
--   v_name   text := 'Store name here';                        -- <-- fill in
--   v_keep   uuid;
--   v_drop   uuid[];
-- begin
--   select id into v_keep from public.locations
--    where tenant_id = v_tenant and name = v_name
--    order by created_at asc limit 1;
--   select array_agg(id) into v_drop from public.locations
--    where tenant_id = v_tenant and name = v_name and id <> v_keep;
--
--   if v_keep is null or v_drop is null then
--     raise notice 'Nothing to merge for %/%' , v_tenant, v_name;
--     return;
--   end if;
--   raise notice 'Keeping %, merging % duplicate(s) into it', v_keep, array_length(v_drop, 1);
--
--   update public.licenses                     set location_id = v_keep where location_id = any(v_drop);
--   update public.license_registrations         set location_id = v_keep where location_id = any(v_drop);
--   update public.employees_cloud               set location_id = v_keep where location_id = any(v_drop);
--   update public.employee_permissions_cloud    set location_id = v_keep where location_id = any(v_drop);
--   update public.inventory_cloud               set location_id = v_keep where location_id = any(v_drop);
--   update public.stock_movements_cloud         set location_id = v_keep where location_id = any(v_drop);
--   update public.transactions_cloud            set location_id = v_keep where location_id = any(v_drop);
--   update public.transaction_items_cloud       set location_id = v_keep where location_id = any(v_drop);
--   update public.storefront_products           set location_id = v_keep where location_id = any(v_drop);
--   update public.online_orders                 set location_id = v_keep where location_id = any(v_drop);
--   update public.cash_drawer_sessions_cloud    set location_id = v_keep where location_id = any(v_drop);
--   update public.applied_rebates_cloud         set location_id = v_keep where location_id = any(v_drop);
--   update public.missed_rebates_cloud          set location_id = v_keep where location_id = any(v_drop);
--   update public.time_clock_cloud              set location_id = v_keep where location_id = any(v_drop);
--   update public.register_commands             set location_id = v_keep where location_id = any(v_drop);
--
--   delete from public.locations where id = any(v_drop);
-- end $$;
-- commit;

-- ── STEP 3 — prevent it from ever happening again (safe once Step 2 is clean) ─
-- Run this AFTER every tenant's duplicates are merged (Step 1 returns no rows).
-- alter table public.locations
--   add constraint locations_tenant_name_unique unique (tenant_id, name);

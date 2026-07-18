-- 019_customers_shared_identity.sql
-- Shared customer book (spec v3, Phase 3). Switch customers_cloud identity from
-- (tenant_id, id) to (tenant_id, uid).
--
-- Why: `id` is each register's local autoincrement, so two tills would both push
-- a customer with id=1 and collide on the old primary key. `uid` is a stable,
-- globally-unique identity (backfilled in 016, generated client-side going
-- forward), so registers in a location converge on the same customer row and
-- edits merge last-write-wins instead of clobbering by id.

-- Safety: ensure every row has a uid before it becomes the key.
update public.customers_cloud set uid = gen_random_uuid() where uid is null;
alter table public.customers_cloud alter column uid set not null;

-- Swap the primary key to (tenant_id, uid). `id` stays as an advisory column
-- (the origin register's local id) but is no longer part of the identity.
alter table public.customers_cloud drop constraint if exists customers_cloud_pkey;
alter table public.customers_cloud add primary key (tenant_id, uid);

-- The standalone unique index from 016 is now redundant with the PK.
drop index if exists public.idx_customers_cloud_tenant_uid;

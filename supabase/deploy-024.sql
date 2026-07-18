-- Rackd cloud schema — INCREMENTAL bundle: manager can create customers.
-- Apply after deploy-023.sql. Idempotent; paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/024_customers_manager_create.sql ====================
-- 024_customers_manager_create.sql
-- Let a manager create customers from the portal.
--
-- customers_cloud.id was the ORIGIN register's local autoincrement id (advisory
-- since 019 made (tenant_id, uid) the primary key). A customer created in the
-- manager portal has no originating register, so `id` must be nullable. Registers
-- that pull the customer down assign their own local id; identity stays `uid`.
alter table public.customers_cloud alter column id drop not null;

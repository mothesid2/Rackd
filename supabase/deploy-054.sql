-- Rackd cloud schema — deploy bundle for migration 054 (inventory_cloud catalog fields: vendor, age_restricted).
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.

-- ==================== supabase/migrations/054_inventory_cloud_catalog_fields.sql ====================
-- 054_inventory_cloud_catalog_fields.sql
--
-- inventory_cloud has been push-only (local -> cloud, reporting mirror) since
-- 005. Adding a real cloud-to-kiosk catalog PULL (so a product added/edited on
-- one kiosk reaches every other kiosk at the same location, not just its own
-- stock-count deltas) means a peer landing a brand-new product locally needs
-- enough fields to create a correct row — including age_restricted, which
-- gates the ID-check prompt at checkout. inventory_cloud was missing both
-- vendor and age_restricted entirely (enqueueInventorySnapshot never selected
-- them), so a synced-in product would have silently lost its 21+ flag. Adding
-- both here; the push side (sync.ts enqueueInventorySnapshot) is updated to
-- populate them alongside this migration.
alter table public.inventory_cloud add column if not exists vendor text;
alter table public.inventory_cloud add column if not exists age_restricted boolean not null default false;

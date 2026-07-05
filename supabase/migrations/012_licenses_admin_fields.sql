-- 012_licenses_admin_fields.sql
-- Fields for the owner admin console: a human-readable tenant name, and a
-- per-tenant display/ads config the owner manages centrally (registers read
-- their own license row and apply it).

alter table public.licenses add column if not exists name text;
alter table public.licenses add column if not exists display_config jsonb not null default '{}'::jsonb;

-- 046_owner_console_expansion.sql
--
-- Backs the expanded Owner Console (spec item 8):
--   1) per-LOCATION POS revenue (transactions_cloud already carries location_id
--      via migration 016, so this is a pure reporting RPC),
--   2) an append-only audit log for owner actions that must never be silent —
--      password resets and permission changes.

-- ── per-location sales aggregate (service-role, owner "Revenue" tab) ──────────
create or replace function public.store_sales_by_location(p_start timestamptz, p_end timestamptz)
returns table (tenant_id uuid, location_id uuid, revenue numeric, txn_count bigint, refund_count bigint)
language sql stable security definer set search_path = public as $$
  select tenant_id, location_id,
         coalesce(sum(total), 0)             as revenue,
         count(*)                            as txn_count,
         count(*) filter (where total < 0)   as refund_count
    from public.transactions_cloud
   where created_at >= p_start and created_at < p_end
   group by tenant_id, location_id;
$$;
grant execute on function public.store_sales_by_location(timestamptz, timestamptz) to service_role;

-- ── append-only owner audit log ──────────────────────────────────────────────
-- Written only by the service-role `admin` Edge Function. No RLS policies on
-- purpose: it is never read or written by tenant sessions, only the owner console.
create table if not exists public.owner_audit_log (
  id           bigint generated always as identity primary key,
  tenant_id    uuid,
  actor        text not null default 'owner_console',
  action       text not null,               -- 'reset_password' | 'set_permission' | ...
  target_uid   uuid,                         -- employee acted upon, when applicable
  target_label text,                         -- human label (username / name)
  detail       jsonb not null default '{}',  -- e.g. {"permission_key":"void_sale","is_granted":true}
  created_at   timestamptz not null default now()
);
create index if not exists idx_owner_audit_tenant on public.owner_audit_log (tenant_id, created_at desc);
alter table public.owner_audit_log enable row level security;
-- (no policies — service_role bypasses RLS; tenant sessions have no access)

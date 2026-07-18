-- Rackd cloud schema — INCREMENTAL bundle: storefront pickup + ID check (Phase 5).
-- Apply after deploy-034.sql. Second 21+ age check at in-store pickup:
-- employee-attributed, append-only audit, enforced in complete_online_pickup().

-- ==================== supabase/migrations/035_storefront_pickup.sql ====================
-- 035_storefront_pickup.sql
-- COMPLIANCE: the SECOND age check, at in-store pickup. When a customer collects
-- an online order, staff must confirm they checked a valid 21+ ID in person. That
-- confirmation is:
--   1) tied to the logged-in employee (uid + name, stamped by the POS session),
--   2) recorded on the order (id_checked_at_pickup, picked_up_by_employee_uid),
--   3) written to an APPEND-ONLY audit log (online_order_pickups) that no client
--      — service role included — can update or delete.
-- complete_online_pickup() does all three atomically and refuses without the check.

-- ── append-only pickup audit ─────────────────────────────────────────────────
create table if not exists public.online_order_pickups (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.online_orders(id),
  tenant_id     uuid not null,
  location_id   uuid not null,
  register_id   text,
  employee_uid  text,
  employee_name text,
  id_checked    boolean not null,
  at            timestamptz not null default now()
);
create index if not exists idx_oop_order on public.online_order_pickups (order_id);
create index if not exists idx_oop_store on public.online_order_pickups (tenant_id, location_id, at);
alter table public.online_order_pickups enable row level security;
-- Store staff read their own store's pickup log; inserts happen via the RPC only.
drop policy if exists "oop_select_staff" on public.online_order_pickups;
create policy "oop_select_staff" on public.online_order_pickups for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
-- Immutable for EVERYONE, including the service role (reuses 029's helper).
drop trigger if exists trg_oop_immutable on public.online_order_pickups;
create trigger trg_oop_immutable
  before update or delete on public.online_order_pickups
  for each row execute function public.block_mutation();

-- ── complete a pickup (register-side, employee-attributed) ───────────────────
-- Called by the STORE STAFF token. p_employee_uid/name come from the POS's local
-- employee session (attribution metadata). Enforces: caller is staff for this
-- store, the ID was checked, and the order is still pickable (not already picked
-- up or cancelled). SECURITY DEFINER so it can write the append-only audit row.
create or replace function public.complete_online_pickup(
  p_order uuid, p_employee_uid text, p_employee_name text, p_id_checked boolean
)
returns public.online_orders
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ord public.online_orders%rowtype;
begin
  if v_tenant is null then raise exception 'not_staff'; end if;
  if p_id_checked is not true then raise exception 'id_check_required'; end if;

  select * into v_ord from public.online_orders where id = p_order;
  if v_ord.id is null then raise exception 'order_not_found'; end if;
  -- Same store scope as oo_update_staff: this tenant, and this location (unless manager).
  if v_ord.tenant_id <> v_tenant
     or not (public.is_manager() or v_ord.location_id = public.current_location_id()) then
    raise exception 'not_authorized';
  end if;
  if v_ord.status not in ('new', 'preparing', 'ready') then
    raise exception 'not_pickable:%', v_ord.status;   -- already picked up / cancelled
  end if;

  update public.online_orders
     set status = 'picked_up', picked_up_at = now(),
         picked_up_by_employee_uid = p_employee_uid, id_checked_at_pickup = true
   where id = p_order
  returning * into v_ord;

  insert into public.online_order_pickups
    (order_id, tenant_id, location_id, register_id, employee_uid, employee_name, id_checked)
  values
    (p_order, v_ord.tenant_id, v_ord.location_id,
     nullif(auth.jwt() ->> 'register_id', ''), p_employee_uid, p_employee_name, true);

  return v_ord;
end;
$$;
revoke all on function public.complete_online_pickup(uuid, text, text, boolean) from public, anon;
grant execute on function public.complete_online_pickup(uuid, text, text, boolean) to authenticated;

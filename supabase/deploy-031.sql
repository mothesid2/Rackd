-- Rackd cloud schema — INCREMENTAL bundle: online storefront (Phase 1).
-- Apply after deploy-030.sql. Adds Supabase Auth-based customer accounts,
-- storefront products/orders, and the atomic age-gate + oversell reserve RPC.

-- ==================== supabase/migrations/031_storefront.sql ====================
-- 031_storefront.sql
-- Customer-facing online storefront (BOPIS — buy online, pick up in store). Adds
-- the FIRST Supabase Auth surface to the project: customer accounts authenticate
-- via auth.users / auth.uid(), coexisting with the POS/portal license JWTs
-- (tenant/location custom claims). The two never collide: license tokens carry no
-- `sub` (so auth.uid() is null for them) and customer tokens carry no tenant claim
-- (so current_tenant_id() is null for them).
--
-- Model: a GLOBAL customer account (marketplace) that links a per-business
-- customers_cloud loyalty row when it orders. Age fields + Stripe id live on the
-- auth-linked profile ONLY (never synced to registers). Oversell + age-gating are
-- enforced atomically in reserve_online_order() at the data layer.

-- ── location opt-in ──────────────────────────────────────────────────────────
alter table public.locations add column if not exists is_storefront_enabled boolean not null default false;
-- Anon may see storefront-enabled locations (to pick one) — name + id only via the API.
drop policy if exists "locations_public_storefront" on public.locations;
create policy "locations_public_storefront" on public.locations for select to anon, authenticated
  using (is_storefront_enabled = true);

-- ── customer account (auth-linked, global) ──────────────────────────────────
create table if not exists public.storefront_customers (
  id                     uuid primary key,          -- = auth.users.id
  email                  text,
  phone                  text,
  dob                    date,
  age_verified           boolean not null default false,
  age_verified_at        timestamptz,
  age_verification_vendor text,                      -- 'persona'
  age_verification_ref   text,                       -- vendor inquiry id
  stripe_customer_id     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table public.storefront_customers enable row level security;
-- A customer sees/edits ONLY their own profile. Store staff never read customer
-- PII here (they see order-level data only). age_verified is set by the Persona
-- webhook (service role), so there's no client UPDATE of the verification fields.
drop policy if exists "sfc_select_self" on public.storefront_customers;
create policy "sfc_select_self" on public.storefront_customers for select to authenticated
  using (auth.uid() = id);
drop policy if exists "sfc_insert_self" on public.storefront_customers;
create policy "sfc_insert_self" on public.storefront_customers for insert to authenticated
  with check (auth.uid() = id);
drop policy if exists "sfc_update_self" on public.storefront_customers;
create policy "sfc_update_self" on public.storefront_customers for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);
create trigger trg_sfc_updated_at before update on public.storefront_customers
  for each row execute function public.set_updated_at();

-- ── which products a store sells online (opt-in) + storefront pricing ────────
create table if not exists public.storefront_products (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  location_id    uuid not null,
  barcode        text not null,             -- shared product identity (not the per-register id)
  is_visible     boolean not null default false,
  override_price numeric(12,2),             -- null = use the POS/inventory price
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (location_id, barcode)
);
create index if not exists idx_sfp_location on public.storefront_products (location_id);
alter table public.storefront_products enable row level security;
-- Public read of VISIBLE products for storefront-enabled locations; managers read
-- + write their own tenant's rows (incl. invisible, for the opt-in UI).
drop policy if exists "sfp_public_read" on public.storefront_products;
create policy "sfp_public_read" on public.storefront_products for select to anon, authenticated
  using (
    (is_visible and exists (select 1 from public.locations l where l.id = location_id and l.is_storefront_enabled))
    or tenant_id = public.current_tenant_id()
  );
drop policy if exists "sfp_manager_insert" on public.storefront_products;
create policy "sfp_manager_insert" on public.storefront_products for insert to authenticated
  with check (public.is_manager() and tenant_id = public.current_tenant_id());
drop policy if exists "sfp_manager_update" on public.storefront_products;
create policy "sfp_manager_update" on public.storefront_products for update to authenticated
  using (public.is_manager() and tenant_id = public.current_tenant_id())
  with check (public.is_manager() and tenant_id = public.current_tenant_id());
create trigger trg_sfp_updated_at before update on public.storefront_products
  for each row execute function public.set_updated_at();

-- ── online orders ────────────────────────────────────────────────────────────
create table if not exists public.online_orders (
  id                       uuid primary key default gen_random_uuid(),
  order_number             text,
  tenant_id                uuid not null,
  location_id              uuid not null,
  customer_id              uuid not null,          -- -> storefront_customers.id (auth.uid())
  status                   text not null default 'pending_payment', -- pending_payment|new|preparing|ready|picked_up|cancelled
  subtotal                 numeric(12,2) not null default 0,
  tax                      numeric(12,2) not null default 0,
  total                    numeric(12,2) not null default 0,
  stripe_payment_intent_id text,
  created_at               timestamptz not null default now(),
  ready_at                 timestamptz,
  picked_up_at             timestamptz,
  picked_up_by_employee_uid text,
  id_checked_at_pickup     boolean not null default false,
  cancel_reason            text,
  updated_at               timestamptz not null default now()
);
create index if not exists idx_online_orders_store on public.online_orders (tenant_id, location_id, status);
create index if not exists idx_online_orders_cust on public.online_orders (customer_id, created_at);
alter table public.online_orders enable row level security;
-- Customer reads own; store staff (register at the location, or tenant manager) read/manage the store's orders.
drop policy if exists "oo_select" on public.online_orders;
create policy "oo_select" on public.online_orders for select to authenticated
  using (
    auth.uid() = customer_id
    or (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  );
-- Only store staff update orders (status, pickup). Inserts happen via the SECURITY
-- DEFINER reserve RPC (no direct client insert).
drop policy if exists "oo_update_staff" on public.online_orders;
create policy "oo_update_staff" on public.online_orders for update to authenticated
  using (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()))
  with check (tenant_id = public.current_tenant_id() and (public.is_manager() or location_id = public.current_location_id()));
create trigger trg_oo_updated_at before update on public.online_orders
  for each row execute function public.set_updated_at();

create table if not exists public.online_order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.online_orders(id) on delete cascade,
  barcode     text,
  name        text,
  qty         integer not null default 1,
  unit_price  numeric(12,2) not null default 0,
  line_total  numeric(12,2) not null default 0
);
create index if not exists idx_ooi_order on public.online_order_items (order_id);
alter table public.online_order_items enable row level security;
drop policy if exists "ooi_select" on public.online_order_items;
create policy "ooi_select" on public.online_order_items for select to authenticated
  using (exists (select 1 from public.online_orders o where o.id = order_id and (
    auth.uid() = o.customer_id
    or (o.tenant_id = public.current_tenant_id() and (public.is_manager() or o.location_id = public.current_location_id()))
  )));

-- ── available stock (cloud view) ────────────────────────────────────────────
-- Best cloud estimate of on-hand for one product at one location: the latest
-- inventory_cloud snapshot for that barcode MINUS quantity already committed to
-- outstanding online orders (reserved). inventory_cloud lags in-store sales by up
-- to the POS sync interval; this is the reservation baseline, not ground truth.
create or replace function public.storefront_available(p_tenant uuid, p_location uuid, p_barcode text)
returns integer language sql stable security definer set search_path = public as $$
  with snap as (
    select quantity from public.inventory_cloud
      where tenant_id = p_tenant and location_id = p_location and barcode = p_barcode
      order by updated_at desc limit 1
  ),
  reserved as (
    select coalesce(sum(i.qty), 0) as q
      from public.online_order_items i
      join public.online_orders o on o.id = i.order_id
     where o.tenant_id = p_tenant and o.location_id = p_location and i.barcode = p_barcode
       and o.status in ('pending_payment', 'new', 'preparing', 'ready')
  )
  select greatest(0, coalesce((select quantity from snap), 0) - (select q from reserved))::integer;
$$;

-- ── reserve an order: age-gate + atomic oversell check + create order ───────
-- Called by the CUSTOMER's authed session. Enforces (in one transaction):
--   1) the caller is age-verified and not expired (p_reverify_days),
--   2) every item is visible + has enough available stock (no oversell),
-- then inserts the order (pending_payment) + items as the reservation. Returns the
-- new order id; the checkout edge function then creates the Stripe PaymentIntent.
create or replace function public.reserve_online_order(
  p_tenant uuid, p_location uuid, p_items jsonb, p_reverify_days integer default 365
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cust uuid := auth.uid();
  v_prof public.storefront_customers%rowtype;
  v_item jsonb;
  v_barcode text; v_qty integer; v_price numeric(12,2); v_name text;
  v_avail integer; v_subtotal numeric(12,2) := 0; v_order uuid;
begin
  if v_cust is null then raise exception 'not authenticated'; end if;

  select * into v_prof from public.storefront_customers where id = v_cust;
  -- COMPLIANCE GATE: block unless verified and within the re-verify window.
  if v_prof.id is null or v_prof.age_verified is not true
     or v_prof.age_verified_at is null
     or v_prof.age_verified_at < now() - make_interval(days => p_reverify_days) then
    raise exception 'age_verification_required';
  end if;

  if not exists (select 1 from public.locations where id = p_location and is_storefront_enabled) then
    raise exception 'location_not_available';
  end if;

  v_order := gen_random_uuid();
  insert into public.online_orders (id, order_number, tenant_id, location_id, customer_id, status)
    values (v_order, upper(substr(v_order::text, 1, 8)), p_tenant, p_location, v_cust, 'pending_payment');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_barcode := v_item ->> 'barcode';
    v_qty := greatest(1, coalesce((v_item ->> 'qty')::int, 1));
    -- Price + visibility come from storefront_products/inventory_cloud, never the client.
    select coalesce(sp.override_price, inv.price), coalesce(inv.name, sp.barcode)
      into v_price, v_name
      from public.storefront_products sp
      left join lateral (
        select price, name from public.inventory_cloud
         where tenant_id = p_tenant and location_id = p_location and barcode = v_barcode
         order by updated_at desc limit 1
      ) inv on true
     where sp.location_id = p_location and sp.barcode = v_barcode and sp.is_visible;
    if v_price is null then raise exception 'item_unavailable:%', v_barcode; end if;

    v_avail := public.storefront_available(p_tenant, p_location, v_barcode);
    if v_avail < v_qty then raise exception 'insufficient_stock:%', v_barcode; end if;

    insert into public.online_order_items (order_id, barcode, name, qty, unit_price, line_total)
      values (v_order, v_barcode, v_name, v_qty, v_price, v_price * v_qty);
    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;

  update public.online_orders set subtotal = v_subtotal, total = v_subtotal where id = v_order;
  return v_order;
end;
$$;
revoke all on function public.reserve_online_order(uuid, uuid, jsonb, integer) from public, anon;
grant execute on function public.reserve_online_order(uuid, uuid, jsonb, integer) to authenticated;
grant execute on function public.storefront_available(uuid, uuid, text) to anon, authenticated;

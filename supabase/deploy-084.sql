-- 084: hardware store catalog and orders. Additive. Reverse with supabase/down/084_down.sql.
-- Stripe is used ONLY for Rackd's own hardware charges. Never for vape/tobacco product payments.

create table if not exists public.hardware_products (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique,
  name           text not null,
  category       text not null check (category in ('station','kit','accessory','consumable')),
  description    text,
  price_cents    integer not null check (price_cents >= 0),
  specs          jsonb not null default '{}'::jsonb,   -- editable; unknown values stay "TBD"
  images         text[] not null default '{}',
  stock_qty      integer not null default 0 check (stock_qty >= 0),
  max_per_order  integer not null default 10 check (max_per_order > 0),
  is_active      boolean not null default true,
  is_placeholder boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.hardware_bundles (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name           text not null,
  description    text,
  model_fit      text not null default 'any' check (model_fit in ('model_a','model_b','any')),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  is_active      boolean not null default true,
  is_placeholder boolean not null default true,
  sort_order     integer not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists public.hardware_bundle_items (
  bundle_id  uuid not null references public.hardware_bundles(id) on delete cascade,
  product_id uuid not null references public.hardware_products(id) on delete restrict,
  quantity   integer not null default 1 check (quantity > 0),
  swap_group text,                       -- items sharing a group can be swapped in the bundle builder
  is_optional boolean not null default false,
  primary key (bundle_id, product_id)
);

create table if not exists public.shipping_addresses (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null,
  company    text,
  line1      text not null,
  line2      text,
  city       text not null,
  state      text not null,
  zip        text not null,
  phone      text,
  created_at timestamptz not null default now()
);

create sequence if not exists public.hardware_order_seq start 1001;

create table if not exists public.hardware_orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null unique default ('HW-' || nextval('public.hardware_order_seq')),
  status               text not null default 'pending'
    check (status in ('pending','paid','fulfilled','shipped','cancelled','refunded')),
  application_id       uuid references public.onboarding_applications(id) on delete set null,
  tenant_id            uuid,                       -- set when placed by an approved, logged-in owner
  email                text not null,
  shipping_address_id  uuid references public.shipping_addresses(id),
  shipping_method      text,
  subtotal_cents       integer not null check (subtotal_cents >= 0),
  shipping_cents       integer not null default 0 check (shipping_cents >= 0),
  tax_cents            integer not null default 0 check (tax_cents >= 0),
  total_cents          integer not null check (total_cents >= 0),
  currency             text not null default 'usd',
  notes                text,
  stripe_session_id    text unique,
  stripe_payment_intent text,
  is_test              boolean not null default true,   -- true while STRIPE_LIVE_ENABLED=false
  access_token_hash    text unique,                     -- guest order-page capability (sha256)
  carrier              text,
  tracking_number      text,
  refund_note          text,
  paid_at              timestamptz,
  shipped_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_hw_orders_status on public.hardware_orders (status, created_at desc);
create index if not exists idx_hw_orders_tenant on public.hardware_orders (tenant_id);

create table if not exists public.hardware_order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.hardware_orders(id) on delete cascade,
  product_id       uuid references public.hardware_products(id) on delete set null,
  name_snapshot    text not null,
  sku_snapshot     text,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity         integer not null check (quantity > 0)
);
create index if not exists idx_hw_items_order on public.hardware_order_items (order_id);

-- Stripe webhook idempotency: insert event id first; a duplicate insert means already handled.
create table if not exists public.stripe_events (
  event_id     text primary key,
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- ---------------------------------------------------------------- RLS
alter table public.hardware_products     enable row level security;
alter table public.hardware_bundles      enable row level security;
alter table public.hardware_bundle_items enable row level security;
alter table public.shipping_addresses    enable row level security;
alter table public.hardware_orders       enable row level security;
alter table public.hardware_order_items  enable row level security;
alter table public.stripe_events         enable row level security;

revoke all on public.hardware_products, public.hardware_bundles, public.hardware_bundle_items,
  public.shipping_addresses, public.hardware_orders, public.hardware_order_items,
  public.stripe_events from anon, authenticated;

-- Catalog: public read of active rows; admin full access.
grant select on public.hardware_products, public.hardware_bundles, public.hardware_bundle_items to anon, authenticated;
grant insert, update, delete on public.hardware_products, public.hardware_bundles, public.hardware_bundle_items to authenticated;

drop policy if exists hw_products_select on public.hardware_products;
create policy hw_products_select on public.hardware_products
  for select to anon, authenticated using (is_active or public.is_platform_admin());
drop policy if exists hw_products_admin on public.hardware_products;
create policy hw_products_admin on public.hardware_products
  for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists hw_bundles_select on public.hardware_bundles;
create policy hw_bundles_select on public.hardware_bundles
  for select to anon, authenticated using (is_active or public.is_platform_admin());
drop policy if exists hw_bundles_admin on public.hardware_bundles;
create policy hw_bundles_admin on public.hardware_bundles
  for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists hw_bundle_items_select on public.hardware_bundle_items;
create policy hw_bundle_items_select on public.hardware_bundle_items
  for select to anon, authenticated using (
    public.is_platform_admin()
    or exists (select 1 from public.hardware_bundles b where b.id = bundle_id and b.is_active));
drop policy if exists hw_bundle_items_admin on public.hardware_bundle_items;
create policy hw_bundle_items_admin on public.hardware_bundle_items
  for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Orders: a business reads only its own; admins read all. All writes go through the server.
grant select on public.hardware_orders, public.hardware_order_items, public.shipping_addresses to authenticated;
grant select on public.stripe_events to authenticated;

drop policy if exists hw_orders_select on public.hardware_orders;
create policy hw_orders_select on public.hardware_orders
  for select to authenticated using (
    public.is_platform_admin()
    or (tenant_id is not null and tenant_id = public.current_tenant_id()));

drop policy if exists hw_order_items_select on public.hardware_order_items;
create policy hw_order_items_select on public.hardware_order_items
  for select to authenticated using (
    exists (select 1 from public.hardware_orders o where o.id = order_id
            and (public.is_platform_admin() or (o.tenant_id is not null and o.tenant_id = public.current_tenant_id()))));

drop policy if exists shipping_addresses_select on public.shipping_addresses;
create policy shipping_addresses_select on public.shipping_addresses
  for select to authenticated using (
    public.is_platform_admin()
    or exists (select 1 from public.hardware_orders o where o.shipping_address_id = shipping_addresses.id
               and o.tenant_id is not null and o.tenant_id = public.current_tenant_id()));

drop policy if exists stripe_events_select on public.stripe_events;
create policy stripe_events_select on public.stripe_events
  for select to authenticated using (public.is_platform_admin());

-- Admin edits to prices/stock/bundles are audit-logged.
create or replace function public.hw_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
do $$
declare t text;
begin
  foreach t in array array['hardware_products','hardware_bundles','hardware_orders'] loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format('create trigger trg_%s_touch before update on public.%I for each row execute function public.hw_touch_updated_at()', t, t);
  end loop;
  foreach t in array array['hardware_products','hardware_bundles','hardware_bundle_items'] loop
    execute format('drop trigger if exists trg_%s_audit on public.%I', t, t);
    execute format('create trigger trg_%s_audit after insert or update or delete on public.%I for each row execute function public.audit_row_change()', t, t);
  end loop;
end $$;

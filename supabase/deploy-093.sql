-- 093: reservations, reservation items, events, outbox, fee ledger, statements, and every RPC that changes them.
-- Reverse with supabase/down/093_down.sql. Needs 092.
--
-- PAYMENTS: there is deliberately NO code path here that accepts, stores or charges a card. Pay-at-pickup is the only
-- implemented mode. 'prepay_card' exists as a value so the UI can show it disabled; creating a reservation in that
-- mode is refused until a gateway is connected (app_config 'storefront_prepay').

-- ---------------------------------------------------------------- tables
create table if not exists public.reservations (
  id                      uuid primary key default gen_random_uuid(),
  code                    text not null,
  tenant_id               uuid not null,
  location_id             uuid not null,
  customer_id             uuid not null,
  customer_name           text,                                   -- "First L."
  status                  text not null default 'new' check (status in ('new', 'confirmed', 'ready', 'picked_up', 'no_show', 'cancelled')),
  subtotal                numeric(12,2) not null default 0 check (subtotal >= 0),
  fee_amount              numeric(12,2) not null default 0 check (fee_amount >= 0),
  fee_type                text check (fee_type in ('percent', 'flat')),
  fee_value               numeric(10,2),
  fee_waived              boolean not null default false,
  fee_waiver_reason       text,
  total                   numeric(12,2) not null default 0 check (total >= 0),
  payment_mode            text not null default 'pay_at_pickup' check (payment_mode in ('pay_at_pickup', 'prepay_card')),
  payment_status          text not null default 'unpaid' check (payment_status in ('unpaid', 'paid_at_register', 'prepaid', 'refunded')),
  age_verified_at_booking timestamptz not null,
  id_checked_at_pickup    boolean not null default false,
  id_checked_by           text,
  id_checked_at           timestamptz,
  notes                   text check (char_length(notes) <= 500),
  cancel_reason           text,
  sale_id                 text,                                   -- POS transaction when completed at a register
  created_at              timestamptz not null default now(),
  confirmed_at            timestamptz,
  ready_at                timestamptz,
  picked_up_at            timestamptz,
  cancelled_at            timestamptz,
  hold_expires_at         timestamptz not null,
  updated_at              timestamptz not null default now(),
  constraint res_total_math check (total = subtotal + fee_amount)
);
create index if not exists idx_res_loc_status on public.reservations (location_id, status, created_at desc);
create index if not exists idx_res_customer on public.reservations (customer_id, created_at desc);
create index if not exists idx_res_hold on public.reservations (hold_expires_at) where status in ('new', 'confirmed', 'ready');

create table if not exists public.reservation_items (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  tenant_id      uuid not null,
  location_id    uuid not null,
  item_id        uuid,
  pos_product_id text,
  name           text not null,
  category       text,
  unit_price     numeric(12,2) not null check (unit_price >= 0),
  qty            integer not null check (qty > 0),
  line_total     numeric(12,2) not null,
  is_removed     boolean not null default false,
  removed_reason text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_res_items_res on public.reservation_items (reservation_id);
create index if not exists idx_res_items_item on public.reservation_items (item_id) where not is_removed;

create table if not exists public.reservation_events (
  id             bigint generated always as identity primary key,
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  tenant_id      uuid not null,
  location_id    uuid not null,
  type           text not null,
  actor          text,
  detail         jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_res_events_res on public.reservation_events (reservation_id, created_at);

create or replace function public.sf_block_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only; % is not allowed', tg_table_name, tg_op; end;
$$;
drop trigger if exists trg_res_events_immutable on public.reservation_events;
create trigger trg_res_events_immutable before update or delete on public.reservation_events for each row execute function public.sf_block_mutation();

-- Email/notification queue: written by triggers, drained by a server job (service role only).
create table if not exists public.storefront_outbox (
  id             bigint generated always as identity primary key,
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  tenant_id      uuid not null,
  location_id    uuid not null,
  kind           text not null,
  audience       text not null check (audience in ('shop', 'customer')),
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  attempts       integer not null default 0,
  last_error     text
);
create index if not exists idx_sf_outbox_pending on public.storefront_outbox (id) where sent_at is null;

create table if not exists public.fee_statements (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  period            text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  total             numeric(12,2) not null default 0,
  reservation_count integer not null default 0,
  status            text not null default 'issued' check (status in ('draft', 'issued', 'paid', 'void')),
  pdf_url           text,
  csv_url           text,
  issued_at         timestamptz,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  unique (tenant_id, period)
);

create table if not exists public.fee_ledger (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  location_id    uuid not null,
  reservation_id uuid not null unique references public.reservations(id),
  amount         numeric(12,2) not null check (amount >= 0),
  status         text not null default 'accrued' check (status in ('accrued', 'invoiced', 'paid', 'waived', 'void')),
  period         text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  statement_id   uuid references public.fee_statements(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_fee_ledger_tenant on public.fee_ledger (tenant_id, period, status);

-- ---------------------------------------------------------------- RLS: reads only; every write goes through an RPC
alter table public.reservations       enable row level security;
alter table public.reservation_items  enable row level security;
alter table public.reservation_events enable row level security;
alter table public.storefront_outbox  enable row level security;
alter table public.fee_ledger         enable row level security;
alter table public.fee_statements     enable row level security;
revoke all on public.reservations, public.reservation_items, public.reservation_events, public.storefront_outbox,
  public.fee_ledger, public.fee_statements from anon, authenticated;
grant select on public.reservations, public.reservation_items, public.reservation_events, public.fee_ledger, public.fee_statements to authenticated;

drop policy if exists res_select on public.reservations;
create policy res_select on public.reservations for select to authenticated using (
  customer_id = auth.uid()
  or (tenant_id = public.current_tenant_id() and public.sf_can('storefront.view'))
  or public.sf_pos_at(location_id));
drop policy if exists res_items_select on public.reservation_items;
create policy res_items_select on public.reservation_items for select to authenticated using (
  exists (select 1 from public.reservations r where r.id = reservation_id));      -- inherits the reservation policy
drop policy if exists res_events_select on public.reservation_events;
create policy res_events_select on public.reservation_events for select to authenticated using (
  (tenant_id = public.current_tenant_id() and public.sf_can('storefront.view')) or public.sf_pos_at(location_id));
drop policy if exists fee_ledger_select on public.fee_ledger;
create policy fee_ledger_select on public.fee_ledger for select to authenticated using (
  tenant_id = public.current_tenant_id() and public.sf_can('storefront.fees.view'));
drop policy if exists fee_statements_select on public.fee_statements;
create policy fee_statements_select on public.fee_statements for select to authenticated using (
  tenant_id = public.current_tenant_id() and public.sf_can('storefront.fees.view'));

-- ---------------------------------------------------------------- availability, fee, hours
create or replace function public.sf_item_available(p_item uuid)
returns integer      -- null = unlimited
language plpgsql stable security definer set search_path = public as $$
declare it public.storefront_items; onhand integer; reserved integer;
begin
  select * into it from public.storefront_items where id = p_item;
  if it.id is null then return 0; end if;
  if it.source = 'pos' then
    select i.quantity into onhand from public.inventory_cloud i
     where i.tenant_id = it.tenant_id and i.location_id = it.location_id and i.barcode = it.pos_product_id
     order by i.updated_at desc limit 1;
    onhand := coalesce(onhand, 0);
  else
    onhand := it.qty;
    if onhand is null then return null; end if;
  end if;
  select coalesce(sum(ri.qty), 0) into reserved
    from public.reservation_items ri join public.reservations r on r.id = ri.reservation_id
   where ri.item_id = p_item and not ri.is_removed and r.status in ('new', 'confirmed', 'ready');
  return greatest(0, onhand - reserved);
end;
$$;
revoke all on function public.sf_item_available(uuid) from public, anon, authenticated;

-- Fee configuration: business override -> plan fee (business_fee_settings) -> platform config -> 5% placeholder.
-- Percent values are percents; flat values are DOLLARS (the plan tables store flat fees in cents, converted here).
create or replace function public.sf_fee_config(p_tenant uuid)
returns table (fee_type text, fee_value numeric, waived boolean, first_order_waiver boolean)
language plpgsql stable security definer set search_path = public as $$
declare d public.business_storefront_defaults; t text; v numeric; cfg jsonb;
begin
  select * into d from public.business_storefront_defaults where tenant_id = p_tenant;
  if d.fee_type is not null then
    t := d.fee_type; v := d.fee_value;
  else
    select online_fee_type, online_fee_value into t, v from public.business_fee_settings where tenant_id = p_tenant;
    if t is null then
      select value into cfg from public.app_config where key = 'online_fee';
      t := coalesce(cfg ->> 'type', 'percent'); v := coalesce((cfg ->> 'value')::numeric, 5);
    end if;
    if t = 'flat' then v := v / 100; end if;
  end if;
  return query select t, v, coalesce(d.fee_waived, false), coalesce(d.first_order_fee_waiver, false);
end;
$$;
revoke all on function public.sf_fee_config(uuid) from public, anon, authenticated;

create or replace function public.sf_compute_fee(p_type text, p_value numeric, p_subtotal numeric)
returns numeric language sql immutable as $$
  select case p_type when 'percent' then round(p_subtotal * p_value / 100, 2) when 'flat' then round(p_value, 2) else 0 end;
$$;

-- Is the shop taking orders right now? (hours are optional; when set, the cutoff applies before closing)
create or replace function public.sf_accepting(p_location uuid, p_at timestamptz default now())
returns boolean language plpgsql stable security definer set search_path = public as $$
declare s public.storefront_settings; tz text; loc timestamp; dow text; h jsonb; cutoff integer; opens time; closes time;
begin
  select * into s from public.storefront_settings where location_id = p_location;
  if s.location_id is null or not s.enabled or s.paused then return false; end if;
  if exists (select 1 from public.business_storefront_defaults d where d.tenant_id = s.tenant_id and not d.storefront_enabled) then return false; end if;
  if s.pickup_hours is null then return true; end if;
  select coalesce(timezone, 'America/Chicago') into tz from public.locations where id = p_location;
  loc := p_at at time zone coalesce(tz, 'America/Chicago');
  dow := lower(substr(to_char(loc, 'Dy'), 1, 3));
  h := s.pickup_hours -> dow;
  if h is null or coalesce((h ->> 'closed')::boolean, false) then return false; end if;
  select order_cutoff_minutes into cutoff from public.sf_effective_settings(p_location);
  opens := (h ->> 'open')::time; closes := (h ->> 'close')::time;
  return loc::time >= opens and loc::time <= (closes - make_interval(mins => coalesce(cutoff, 0)));
exception when others then return true;      -- malformed hours must never lock a shop out by accident
end;
$$;
revoke all on function public.sf_accepting(uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------- customer contract
create or replace function public.storefront_public_info(p_location uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.storefront_settings; f record; eff record; d public.business_storefront_defaults;
begin
  select * into s from public.storefront_settings where location_id = p_location;
  if s.location_id is null or not s.enabled then return jsonb_build_object('enabled', false); end if;
  select * into d from public.business_storefront_defaults where tenant_id = s.tenant_id;
  if d.tenant_id is not null and not d.storefront_enabled then return jsonb_build_object('enabled', false); end if;
  select * into f from public.sf_fee_config(s.tenant_id);
  select * into eff from public.sf_effective_settings(p_location);
  return jsonb_build_object(
    'enabled', true, 'paused', s.paused, 'pause_reason', s.pause_reason, 'accepting', public.sf_accepting(p_location),
    'pickup_instructions', s.pickup_instructions, 'hold_minutes', eff.hold_minutes,
    'max_items_per_order', eff.max_items_per_order, 'max_qty_per_item', eff.max_qty_per_item,
    'payment_mode', 'pay_at_pickup', 'prepay_available', false,
    'fee', jsonb_build_object('type', f.fee_type, 'value', f.fee_value, 'waived', f.waived, 'first_order_waiver', f.first_order_waiver, 'label', 'Reservation fee'));
end;
$$;
grant execute on function public.storefront_public_info(uuid) to anon, authenticated;

create or replace function public.storefront_menu_v2(p_location uuid)
returns table (item_id uuid, name text, brand text, flavor text, size text, category text, price numeric, image_url text, status text, available integer, sort_order integer)
language sql stable security definer set search_path = public as $$
  with base as (
    select it.id, it.sort_order, it.status as item_status, it.brand, it.flavor, it.size, it.image_url,
           coalesce(it.name, inv.name) as name, coalesce(it.category, inv.category) as category, coalesce(it.price, inv.price) as price,
           public.sf_item_available(it.id) as avail
      from public.storefront_items it
      join public.storefront_settings s on s.location_id = it.location_id and s.enabled
      left join lateral (select i.name, i.category, i.price from public.inventory_cloud i
                          where it.source = 'pos' and i.tenant_id = it.tenant_id and i.location_id = it.location_id and i.barcode = it.pos_product_id
                          order by i.updated_at desc limit 1) inv on true
     where it.location_id = p_location and it.status <> 'hidden'
       and not exists (select 1 from public.business_storefront_defaults d where d.tenant_id = it.tenant_id and not d.storefront_enabled))
  select id, name, brand, flavor, size, category, price, image_url,
         case when item_status = 'sold_out' or avail = 0 then 'sold_out' else 'available' end,
         avail, sort_order
    from base where name is not null and price is not null order by sort_order, name;
$$;
grant execute on function public.storefront_menu_v2(uuid) to anon, authenticated;

create or replace function public.create_reservation(p_location uuid, p_items jsonb, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cust uuid := auth.uid(); v_prof public.storefront_customers; s public.storefront_settings; eff record; f record;
  v_ids uuid[]; v_line jsonb; v_it public.storefront_items; v_avail integer; v_qty integer; v_price numeric; v_name text; v_cat text;
  v_subtotal numeric(12,2) := 0; v_total_qty integer := 0; v_fee numeric(12,2) := 0; v_waived boolean := false; v_reason text;
  v_res public.reservations; v_id uuid := gen_random_uuid(); v_prepay boolean;
begin
  if v_cust is null then raise exception 'not authenticated'; end if;
  select * into s from public.storefront_settings where location_id = p_location;
  if s.location_id is null or not s.enabled then raise exception 'location_not_available'; end if;
  if not public.sf_accepting(p_location) then raise exception 'not_accepting_orders'; end if;
  if s.payment_mode <> 'pay_at_pickup' then
    select coalesce((value ->> 'enabled')::boolean, false) into v_prepay from public.app_config where key = 'storefront_prepay';
    raise exception 'prepay_not_available';       -- no implemented card path: always refuse
  end if;

  select * into v_prof from public.storefront_customers where id = v_cust;
  if v_prof.id is null or v_prof.age_verified is not true or v_prof.age_verified_at is null or v_prof.age_verified_at < now() - interval '365 days' then
    raise exception 'age_verification_required';
  end if;

  if (select count(*) from public.reservations where customer_id = v_cust and created_at > now() - interval '1 hour') >= 5 then raise exception 'rate_limited'; end if;
  if (select count(*) from public.reservations where customer_id = v_cust and location_id = p_location and status in ('new', 'confirmed', 'ready')) >= 3 then
    raise exception 'too_many_open_reservations';
  end if;

  select * into eff from public.sf_effective_settings(p_location);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'cart_empty'; end if;

  -- lock every requested item in a fixed order: two customers racing for the last unit are serialized here
  select array_agg(distinct (x ->> 'item_id')::uuid order by (x ->> 'item_id')::uuid) into v_ids from jsonb_array_elements(p_items) x;
  perform 1 from public.storefront_items where id = any (v_ids) order by id for update;

  insert into public.reservations (id, code, tenant_id, location_id, customer_id, customer_name, status, payment_mode, age_verified_at_booking, notes, hold_expires_at)
  values (v_id, upper(substr(v_id::text, 1, 8)), s.tenant_id, p_location, v_cust,
          nullif(trim(coalesce(v_prof.first_name, '') || ' ' || coalesce(left(v_prof.last_name, 1) || '.', '')), ''),
          'new', 'pay_at_pickup', v_prof.age_verified_at, left(nullif(trim(p_notes), ''), 500), now() + make_interval(mins => eff.hold_minutes));

  for v_line in select * from jsonb_array_elements(p_items) loop
    v_qty := coalesce((v_line ->> 'qty')::integer, 0);
    if v_qty < 1 then raise exception 'qty_invalid'; end if;
    if v_qty > eff.max_qty_per_item then raise exception 'qty_over_limit:%', v_line ->> 'item_id'; end if;
    select * into v_it from public.storefront_items where id = (v_line ->> 'item_id')::uuid and location_id = p_location;
    if v_it.id is null or v_it.status <> 'available' then raise exception 'item_unavailable:%', v_line ->> 'item_id'; end if;
    v_avail := public.sf_item_available(v_it.id);
    if v_avail is not null and v_avail < v_qty then raise exception 'insufficient_stock:%', v_it.id; end if;
    if v_it.source = 'pos' then
      select i.name, i.category, i.price into v_name, v_cat, v_price from public.inventory_cloud i
       where i.tenant_id = v_it.tenant_id and i.location_id = v_it.location_id and i.barcode = v_it.pos_product_id order by i.updated_at desc limit 1;
    else
      v_name := v_it.name; v_cat := v_it.category; v_price := v_it.price;
    end if;
    if v_price is null or v_name is null then raise exception 'item_unavailable:%', v_it.id; end if;
    insert into public.reservation_items (reservation_id, tenant_id, location_id, item_id, pos_product_id, name, category, unit_price, qty, line_total)
    values (v_id, s.tenant_id, p_location, v_it.id, v_it.pos_product_id, v_name, coalesce(v_it.category, v_cat), v_price, v_qty, v_price * v_qty);
    v_subtotal := v_subtotal + v_price * v_qty;
    v_total_qty := v_total_qty + v_qty;
  end loop;
  if v_total_qty > eff.max_items_per_order then raise exception 'too_many_items'; end if;

  select * into f from public.sf_fee_config(s.tenant_id);
  v_fee := public.sf_compute_fee(f.fee_type, f.fee_value, v_subtotal);
  if f.waived then v_waived := true; v_reason := 'business waiver';
  elsif f.first_order_waiver and not exists (select 1 from public.reservations r where r.customer_id = v_cust and r.tenant_id = s.tenant_id
                                                and r.id <> v_id and r.status not in ('cancelled', 'no_show')) then
    v_waived := true; v_reason := 'first order';
  end if;
  update public.reservations set subtotal = v_subtotal, fee_type = f.fee_type, fee_value = f.fee_value, fee_waived = v_waived, fee_waiver_reason = v_reason,
         fee_amount = case when v_waived then 0 else v_fee end, total = v_subtotal + case when v_waived then 0 else v_fee end
   where id = v_id returning * into v_res;

  insert into public.reservation_events (reservation_id, tenant_id, location_id, type, actor, detail)
  values (v_id, s.tenant_id, p_location, 'created', 'customer', jsonb_build_object('items', v_total_qty, 'subtotal', v_subtotal));
  insert into public.storefront_outbox (reservation_id, tenant_id, location_id, kind, audience) values (v_id, s.tenant_id, p_location, 'new_reservation', 'shop');
  perform public.sf_bump_menu(p_location);
  return public.sf_reservation_json(v_id);
end;
$$;

create or replace function public.sf_reservation_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(r) || jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from public.reservation_items i where i.reservation_id = r.id), '[]'::jsonb))
    from public.reservations r where r.id = p_id;
$$;
revoke all on function public.sf_reservation_json(uuid) from public, anon, authenticated;

create or replace function public.cancel_my_reservation(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_id and customer_id = auth.uid() for update;
  if r.id is null then raise exception 'reservation_not_found'; end if;
  if r.status not in ('new', 'confirmed') then raise exception 'not_cancellable:%', r.status; end if;
  update public.reservations set status = 'cancelled', cancelled_at = now(), cancel_reason = 'cancelled by customer' where id = p_id;
  insert into public.reservation_events (reservation_id, tenant_id, location_id, type, actor, detail) values (p_id, r.tenant_id, r.location_id, 'cancelled', 'customer', null);
  perform public.sf_bump_menu(r.location_id);
end;
$$;

-- ---------------------------------------------------------------- staff actions
create or replace function public.sf_actor_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(e.name, e.username) from public.employees_cloud e where e.tenant_id = public.current_tenant_id() and e.uid = public.sf_employee_uid()),
                  case when public.sf_is_owner() then 'Owner Console' end, 'staff');
$$;
revoke all on function public.sf_actor_name() from public, anon, authenticated;

create or replace function public.sf_res_for_staff(p_id uuid)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_id for update;
  if r.id is null then raise exception 'reservation_not_found'; end if;
  if r.tenant_id is distinct from public.current_tenant_id() or not public.sf_can('storefront.orders.manage') then raise exception 'forbidden' using errcode = '42501'; end if;
  return r;
end;
$$;
revoke all on function public.sf_res_for_staff(uuid) from public, anon, authenticated;

create or replace function public.sf_accrue_fee(p_res uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations; tz text;
begin
  select * into r from public.reservations where id = p_res;
  select coalesce(timezone, 'America/Chicago') into tz from public.locations where id = r.location_id;
  insert into public.fee_ledger (tenant_id, location_id, reservation_id, amount, status, period)
  values (r.tenant_id, r.location_id, r.id, r.fee_amount, case when r.fee_waived or r.fee_amount = 0 then 'waived' else 'accrued' end,
          to_char(r.picked_up_at at time zone coalesce(tz, 'America/Chicago'), 'YYYY-MM'))
  on conflict (reservation_id) do nothing;
end;
$$;
revoke all on function public.sf_accrue_fee(uuid) from public, anon, authenticated;

create or replace function public.sf_log(p_res public.reservations, p_type text, p_detail jsonb default null, p_notify text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.reservation_events (reservation_id, tenant_id, location_id, type, actor, detail) values (p_res.id, p_res.tenant_id, p_res.location_id, p_type, public.sf_actor_name(), p_detail);
  if p_notify is not null then
    insert into public.storefront_outbox (reservation_id, tenant_id, location_id, kind, audience) values (p_res.id, p_res.tenant_id, p_res.location_id, p_notify, 'customer');
  end if;
  perform public.sf_bump_menu(p_res.location_id);
end;
$$;
revoke all on function public.sf_log(public.reservations, text, jsonb, text) from public, anon, authenticated;

create or replace function public.sf_reservation_confirm(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  r := public.sf_res_for_staff(p_id);
  if r.status <> 'new' then raise exception 'invalid_transition: % -> confirmed', r.status; end if;
  update public.reservations set status = 'confirmed', confirmed_at = now() where id = p_id;
  perform public.sf_log(r, 'confirmed', null, 'confirmed');
end; $$;

create or replace function public.sf_reservation_ready(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  r := public.sf_res_for_staff(p_id);
  if r.status not in ('new', 'confirmed') then raise exception 'invalid_transition: % -> ready', r.status; end if;
  update public.reservations set status = 'ready', ready_at = now(), confirmed_at = coalesce(confirmed_at, now()) where id = p_id;
  perform public.sf_log(r, 'ready', null, 'ready');
end; $$;

-- ID rule: the shop's toggle, and ALWAYS for restricted categories (vape, tobacco, nicotine...).
create or replace function public.sf_id_required(p_res uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.require_id_at_pickup from public.storefront_settings s join public.reservations r on r.location_id = s.location_id where r.id = p_res), true)
      or exists (select 1 from public.reservation_items i where i.reservation_id = p_res and not i.is_removed
                  and coalesce(i.category, '') ~* '(vape|vapor|tobacco|cigar|cigarette|nicotine|e-?liquid|e-?juice|hookah|disposable|pod|smok)');
$$;
revoke all on function public.sf_id_required(uuid) from public, anon, authenticated;

create or replace function public.sf_reservation_pickup(p_id uuid, p_id_checked boolean)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  r := public.sf_res_for_staff(p_id);
  if r.status not in ('new', 'confirmed', 'ready') then raise exception 'invalid_transition: % -> picked_up', r.status; end if;
  if public.sf_id_required(p_id) and p_id_checked is not true then raise exception 'id_check_required'; end if;
  update public.reservations set status = 'picked_up', picked_up_at = now(), id_checked_at_pickup = coalesce(p_id_checked, false),
         id_checked_by = case when p_id_checked then public.sf_actor_name() end, id_checked_at = case when p_id_checked then now() end
   where id = p_id;
  perform public.sf_accrue_fee(p_id);
  perform public.sf_log(r, 'picked_up', jsonb_build_object('id_checked', coalesce(p_id_checked, false)));
end; $$;

create or replace function public.sf_reservation_no_show(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  r := public.sf_res_for_staff(p_id);
  if r.status not in ('new', 'confirmed', 'ready') then raise exception 'invalid_transition: % -> no_show', r.status; end if;
  update public.reservations set status = 'no_show', cancelled_at = now(), cancel_reason = 'no show' where id = p_id;   -- no fee is accrued
  perform public.sf_log(r, 'no_show', null, 'no_show');
end; $$;

create or replace function public.sf_reservation_cancel(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  r := public.sf_res_for_staff(p_id);
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if r.status not in ('new', 'confirmed', 'ready') then raise exception 'invalid_transition: % -> cancelled', r.status; end if;
  update public.reservations set status = 'cancelled', cancelled_at = now(), cancel_reason = left(trim(p_reason), 300) where id = p_id;
  perform public.sf_log(r, 'cancelled', jsonb_build_object('reason', left(trim(p_reason), 300)), 'cancelled');
end; $$;

create or replace function public.sf_reservation_pay_register(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  r := public.sf_res_for_staff(p_id);
  if r.payment_mode <> 'pay_at_pickup' then raise exception 'not_pay_at_pickup'; end if;
  if r.status in ('cancelled', 'no_show') then raise exception 'invalid_transition: % -> paid', r.status; end if;
  update public.reservations set payment_status = 'paid_at_register' where id = p_id;
  perform public.sf_log(r, 'paid_at_register', jsonb_build_object('total', r.total));
end; $$;

-- "Item unavailable": remove a line (or replace it), recalculate with the SAME fee snapshot, tell the customer.
create or replace function public.sf_reservation_item_unavailable(p_id uuid, p_line uuid, p_replacement uuid default null, p_replacement_qty integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.reservations; l public.reservation_items; it public.storefront_items; eff record; v_avail integer; v_price numeric; v_name text; v_cat text;
        v_sub numeric(12,2); v_fee numeric(12,2); v_qty integer; v_remaining integer;
begin
  r := public.sf_res_for_staff(p_id);
  if r.status not in ('new', 'confirmed', 'ready') then raise exception 'invalid_transition: % -> items_changed', r.status; end if;
  select * into l from public.reservation_items where id = p_line and reservation_id = p_id and not is_removed;
  if l.id is null then raise exception 'line_not_found'; end if;
  select count(*) into v_remaining from public.reservation_items where reservation_id = p_id and not is_removed and id <> p_line;
  if v_remaining = 0 and p_replacement is null then raise exception 'cannot_remove_last_item'; end if;

  update public.reservation_items set is_removed = true, removed_reason = 'unavailable' where id = p_line;
  if p_replacement is not null then
    perform 1 from public.storefront_items where id = p_replacement and location_id = r.location_id for update;
    select * into it from public.storefront_items where id = p_replacement and location_id = r.location_id;
    if it.id is null or it.status <> 'available' then raise exception 'item_unavailable:%', p_replacement; end if;
    v_qty := coalesce(p_replacement_qty, l.qty);
    select * into eff from public.sf_effective_settings(r.location_id);
    if v_qty < 1 or v_qty > eff.max_qty_per_item then raise exception 'qty_over_limit:%', p_replacement; end if;
    v_avail := public.sf_item_available(it.id);
    if v_avail is not null and v_avail < v_qty then raise exception 'insufficient_stock:%', it.id; end if;
    if it.source = 'pos' then
      select i.name, i.category, i.price into v_name, v_cat, v_price from public.inventory_cloud i where i.tenant_id = it.tenant_id and i.location_id = it.location_id and i.barcode = it.pos_product_id order by i.updated_at desc limit 1;
    else v_name := it.name; v_cat := it.category; v_price := it.price; end if;
    if v_price is null then raise exception 'item_unavailable:%', p_replacement; end if;
    insert into public.reservation_items (reservation_id, tenant_id, location_id, item_id, pos_product_id, name, category, unit_price, qty, line_total)
    values (p_id, r.tenant_id, r.location_id, it.id, it.pos_product_id, v_name, coalesce(it.category, v_cat), v_price, v_qty, v_price * v_qty);
  end if;

  select coalesce(sum(line_total), 0) into v_sub from public.reservation_items where reservation_id = p_id and not is_removed;
  v_fee := case when r.fee_waived then 0 else public.sf_compute_fee(r.fee_type, r.fee_value, v_sub) end;
  update public.reservations set subtotal = v_sub, fee_amount = v_fee, total = v_sub + v_fee where id = p_id;
  perform public.sf_log(r, 'items_changed', jsonb_build_object('removed', l.name, 'replacement', v_name, 'subtotal', v_sub, 'total', v_sub + v_fee), 'items_changed');
  return public.sf_reservation_json(p_id);
end; $$;

-- POS: completing a reservation as a NORMAL sale at the register. The sale is an ordinary sale (it stays in X/Z).
create or replace function public.pos_link_reservation_sale(p_id uuid, p_sale text, p_employee_uid text, p_employee_name text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_id for update;
  if r.id is null then raise exception 'reservation_not_found'; end if;
  if not public.sf_pos_at(r.location_id) or r.tenant_id <> public.current_tenant_id() then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.status not in ('new', 'confirmed', 'ready') then raise exception 'invalid_transition: % -> picked_up', r.status; end if;
  if coalesce(trim(p_sale), '') = '' then raise exception 'sale_required'; end if;
  update public.reservations set status = 'picked_up', picked_up_at = now(), sale_id = left(p_sale, 60), payment_status = 'paid_at_register',
         id_checked_at_pickup = true, id_checked_by = left(coalesce(p_employee_name, 'POS'), 80), id_checked_at = now() where id = p_id;
  perform public.sf_accrue_fee(p_id);
  insert into public.reservation_events (reservation_id, tenant_id, location_id, type, actor, detail)
  values (p_id, r.tenant_id, r.location_id, 'picked_up', coalesce(p_employee_name, 'POS'), jsonb_build_object('sale', p_sale, 'via', 'pos'));
  perform public.sf_bump_menu(r.location_id);
end; $$;

-- ---------------------------------------------------------------- scheduled: hold expiry (service role)
create or replace function public.expire_reservation_holds()
returns integer language plpgsql security definer set search_path = public as $$
declare r public.reservations; n integer := 0; v_auto boolean;
begin
  for r in select * from public.reservations where status in ('new', 'confirmed', 'ready') and hold_expires_at < now() order by hold_expires_at for update skip locked loop
    select coalesce(auto_cancel_no_show, true) into v_auto from public.storefront_settings where location_id = r.location_id;
    continue when not coalesce(v_auto, true);
    update public.reservations set status = case when r.status = 'ready' then 'no_show' else 'cancelled' end, cancelled_at = now(),
           cancel_reason = case when r.status = 'ready' then 'no show (hold expired)' else 'hold expired' end where id = r.id;
    insert into public.reservation_events (reservation_id, tenant_id, location_id, type, actor, detail)
    values (r.id, r.tenant_id, r.location_id, case when r.status = 'ready' then 'no_show' else 'cancelled' end, 'system', jsonb_build_object('reason', 'hold expired'));
    insert into public.storefront_outbox (reservation_id, tenant_id, location_id, kind, audience)
    values (r.id, r.tenant_id, r.location_id, case when r.status = 'ready' then 'no_show' else 'cancelled' end, 'customer');
    perform public.sf_bump_menu(r.location_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------- statements (service role; Rackd issues them)
create or replace function public.sf_build_statement(p_tenant uuid, p_period text, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_total numeric(12,2); v_count integer; v_id uuid; v_existing public.fee_statements; v_lines jsonb;
begin
  if p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'period_invalid'; end if;
  select * into v_existing from public.fee_statements where tenant_id = p_tenant and period = p_period;
  if v_existing.id is not null and v_existing.status <> 'draft' and not p_dry_run then
    return jsonb_build_object('statement_id', v_existing.id, 'period', p_period, 'total', v_existing.total, 'count', v_existing.reservation_count, 'already_issued', true, 'dry_run', false);
  end if;
  select coalesce(sum(amount), 0), count(*) into v_total, v_count from public.fee_ledger where tenant_id = p_tenant and period = p_period and status = 'accrued';
  select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'location_id', l.location_id, 'amount', l.amount, 'picked_up_at', r.picked_up_at, 'subtotal', r.subtotal) order by r.picked_up_at), '[]'::jsonb)
    into v_lines from public.fee_ledger l join public.reservations r on r.id = l.reservation_id
   where l.tenant_id = p_tenant and l.period = p_period and l.status = 'accrued';
  if p_dry_run then
    return jsonb_build_object('period', p_period, 'total', v_total, 'count', v_count, 'lines', v_lines, 'dry_run', true);
  end if;
  insert into public.fee_statements (tenant_id, period, total, reservation_count, status, issued_at)
  values (p_tenant, p_period, v_total, v_count, 'issued', now())
  on conflict (tenant_id, period) do update set total = excluded.total, reservation_count = excluded.reservation_count, status = 'issued', issued_at = now()
  returning id into v_id;
  update public.fee_ledger set status = 'invoiced', statement_id = v_id, updated_at = now() where tenant_id = p_tenant and period = p_period and status = 'accrued';
  perform public.write_audit('fee_statement.issue', 'fee_statements', v_id::text, null, jsonb_build_object('period', p_period, 'total', v_total, 'count', v_count), null);
  return jsonb_build_object('statement_id', v_id, 'period', p_period, 'total', v_total, 'count', v_count, 'lines', v_lines, 'dry_run', false);
end;
$$;

-- Rackd marks the shop's statement paid (Owner Console token).
create or replace function public.sf_mark_statement_paid(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare st public.fee_statements;
begin
  if not public.sf_is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into st from public.fee_statements where id = p_id and tenant_id = public.current_tenant_id() for update;
  if st.id is null then raise exception 'statement_not_found'; end if;
  if st.status = 'paid' then return; end if;
  if st.status <> 'issued' then raise exception 'invalid_transition: % -> paid', st.status; end if;
  update public.fee_statements set status = 'paid', paid_at = now() where id = p_id;
  update public.fee_ledger set status = 'paid', updated_at = now() where statement_id = p_id and status = 'invoiced';
  perform public.write_audit('fee_statement.paid', 'fee_statements', p_id::text, jsonb_build_object('status', st.status), jsonb_build_object('status', 'paid'), null);
end;
$$;

-- ---------------------------------------------------------------- reports
create or replace function public.sf_report(p_location uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); out jsonb;
begin
  if not public.sf_can('storefront.reports.view') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_location is not null and public.sf_location_tenant(p_location) is distinct from v_tenant then raise exception 'forbidden' using errcode = '42501'; end if;
  with r as (select * from public.reservations x where x.tenant_id = v_tenant and (p_location is null or x.location_id = p_location) and x.created_at >= p_from and x.created_at < p_to)
  select jsonb_build_object(
    'orders', (select count(*) from r),
    'by_status', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from r group by status) s), '{}'::jsonb),
    'online_sales', coalesce((select sum(subtotal) from r where status = 'picked_up'), 0),
    'fees_accrued', coalesce((select sum(l.amount) from public.fee_ledger l where l.tenant_id = v_tenant and (p_location is null or l.location_id = p_location)
                               and l.reservation_id in (select id from r) and l.status in ('accrued', 'invoiced', 'paid')), 0),
    'no_show_rate', coalesce((select round(count(*) filter (where status = 'no_show')::numeric / nullif(count(*) filter (where status in ('picked_up', 'no_show')), 0), 4) from r), 0),
    'top_items', coalesce((select jsonb_agg(t) from (select i.name, sum(i.qty) as qty, sum(i.line_total) as revenue
                              from public.reservation_items i join r on r.id = i.reservation_id and r.status = 'picked_up' where not i.is_removed
                              group by i.name order by sum(i.qty) desc, i.name limit 10) t), '[]'::jsonb),
    'hourly', coalesce((select jsonb_agg(h) from (select extract(dow from created_at at time zone 'America/Chicago')::int as dow,
                              extract(hour from created_at at time zone 'America/Chicago')::int as hour, count(*) as orders from r group by 1, 2 order by 1, 2) h), '[]'::jsonb),
    'by_location', coalesce((select jsonb_agg(b) from (select location_id, count(*) as orders, coalesce(sum(subtotal) filter (where status = 'picked_up'), 0) as online_sales from r group by location_id) b), '[]'::jsonb)
  ) into out;
  return out;
end;
$$;

-- Dashboard tiles for one location.
create or replace function public.sf_dashboard(p_location uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); tz text; s public.storefront_settings; out jsonb;
begin
  if not public.sf_can('storefront.view') then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.sf_location_tenant(p_location) is distinct from v_tenant then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(timezone, 'America/Chicago') into tz from public.locations where id = p_location;
  select * into s from public.storefront_settings where location_id = p_location;
  select jsonb_build_object(
    'enabled', coalesce(s.enabled, false), 'paused', coalesce(s.paused, false), 'pause_reason', s.pause_reason,
    'today', (select count(*) from public.reservations r where r.location_id = p_location and (r.created_at at time zone tz)::date = (now() at time zone tz)::date),
    'pending', (select count(*) from public.reservations r where r.location_id = p_location and r.status = 'new'),
    'sold_out', (select count(*) from public.storefront_items i where i.location_id = p_location and i.status = 'sold_out'),
    'orders_7d', (select count(*) from public.reservations r where r.location_id = p_location and r.created_at >= now() - interval '7 days'),
    'sales_7d', coalesce((select sum(r.subtotal) from public.reservations r where r.location_id = p_location and r.status = 'picked_up' and r.created_at >= now() - interval '7 days'), 0),
    'fees_7d', coalesce((select sum(l.amount) from public.fee_ledger l where l.location_id = p_location and l.status <> 'void' and l.created_at >= now() - interval '7 days'), 0),
    'no_show_rate_30d', coalesce((select round(count(*) filter (where r.status = 'no_show')::numeric / nullif(count(*) filter (where r.status in ('picked_up', 'no_show')), 0), 4)
                                    from public.reservations r where r.location_id = p_location and r.created_at >= now() - interval '30 days'), 0)
  ) into out;
  return out;
end;
$$;

-- ---------------------------------------------------------------- menu signal on reservation changes + grants
create or replace function public.sf_res_bump_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.sf_bump_menu(coalesce(new.location_id, old.location_id)); return coalesce(new, old); end; $$;
drop trigger if exists trg_res_touch on public.reservations;
create trigger trg_res_touch before update on public.reservations for each row execute function public.set_updated_at();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.reservations;
    alter publication supabase_realtime add table public.reservation_items;
  end if;
exception when duplicate_object then null;
end $$;

revoke all on function public.create_reservation(uuid, jsonb, text), public.cancel_my_reservation(uuid),
  public.sf_reservation_confirm(uuid), public.sf_reservation_ready(uuid), public.sf_reservation_pickup(uuid, boolean),
  public.sf_reservation_no_show(uuid), public.sf_reservation_cancel(uuid, text), public.sf_reservation_pay_register(uuid),
  public.sf_reservation_item_unavailable(uuid, uuid, uuid, integer), public.pos_link_reservation_sale(uuid, text, text, text),
  public.sf_mark_statement_paid(uuid), public.sf_report(uuid, timestamptz, timestamptz), public.sf_dashboard(uuid),
  public.expire_reservation_holds(), public.sf_build_statement(uuid, text, boolean), public.sf_compute_fee(text, numeric, numeric) from public, anon;
grant execute on function public.create_reservation(uuid, jsonb, text), public.cancel_my_reservation(uuid),
  public.sf_reservation_confirm(uuid), public.sf_reservation_ready(uuid), public.sf_reservation_pickup(uuid, boolean),
  public.sf_reservation_no_show(uuid), public.sf_reservation_cancel(uuid, text), public.sf_reservation_pay_register(uuid),
  public.sf_reservation_item_unavailable(uuid, uuid, uuid, integer), public.pos_link_reservation_sale(uuid, text, text, text),
  public.sf_mark_statement_paid(uuid), public.sf_report(uuid, timestamptz, timestamptz), public.sf_dashboard(uuid), public.sf_compute_fee(text, numeric, numeric) to authenticated;
revoke execute on function public.expire_reservation_holds(), public.sf_build_statement(uuid, text, boolean) from authenticated;
grant execute on function public.expire_reservation_holds(), public.sf_build_statement(uuid, text, boolean) to service_role;

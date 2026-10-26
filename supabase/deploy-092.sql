-- 092: Storefront Manager core: permission helpers, business defaults, per-location settings, curated/POS items,
-- menu change signal. Reverse with supabase/down/092_down.sql.
--
-- Identity model (unchanged): staff-login issues a JWT with kind='manager', tenant_id, employee_uid (no location).
-- The Owner Console gets kind='owner' tokens (minted by the admin edge function). POS devices use kind='register'
-- with a location_id claim. Per-user storefront permissions are rows in employee_permissions_cloud; this migration
-- makes the DATABASE enforce them (sf_can), so hiding a button in the UI is never the only protection.

-- ---------------------------------------------------------------- identity helpers
create or replace function public.sf_is_owner()
returns boolean language sql stable as $$ select coalesce(auth.jwt() ->> 'kind', '') = 'owner'; $$;

create or replace function public.sf_employee_uid()
returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'employee_uid', '')::uuid; $$;

create or replace function public.sf_is_admin_role()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.employees_cloud e
     where e.tenant_id = public.current_tenant_id() and e.uid = public.sf_employee_uid()
       and e.is_active is not false and e.role = 'admin');
$$;

-- Default for a manager with no explicit row: day-to-day keys on, money and settings keys off.
create or replace function public.sf_default_grant(p_key text)
returns boolean language sql immutable as $$
  select p_key in ('storefront.view', 'storefront.items.edit', 'storefront.orders.manage', 'storefront.reports.view');
$$;

-- True when the caller may use this storefront permission within their own tenant.
create or replace function public.sf_can(p_key text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare k text := coalesce(auth.jwt() ->> 'kind', ''); v boolean;
begin
  if public.current_tenant_id() is null then return false; end if;
  if k = 'owner' then return true; end if;
  if k <> 'manager' then return false; end if;
  if public.sf_is_admin_role() then return true; end if;
  select p.is_granted into v from public.employee_permissions_cloud p
   where p.tenant_id = public.current_tenant_id() and p.employee_uid = public.sf_employee_uid() and p.permission_key = p_key
   order by p.updated_at desc limit 1;
  return coalesce(v, public.sf_default_grant(p_key));
end;
$$;

-- A register (POS) token for exactly this location.
create or replace function public.sf_pos_at(p_location uuid)
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'kind', '') = 'register'
     and public.current_location_id() = p_location and public.current_tenant_id() is not null;
$$;

-- Does the caller's tenant own this location?
create or replace function public.sf_location_tenant(p_location uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from public.locations where id = p_location;
$$;

-- ---------------------------------------------------------------- DB-side switches (platform admin edits)
insert into public.app_config (key, value, is_public, description) values
  ('storefront_prepay', '{"enabled": false}', false,
   'Prepay (card) for storefront reservations. Stays false until a gateway that supports these products is connected. Never routed through Stripe.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- business-level defaults
create table if not exists public.business_storefront_defaults (
  tenant_id               uuid primary key,
  storefront_enabled      boolean not null default true,    -- business master switch (Owner Console)
  hold_minutes            integer not null default 60  check (hold_minutes between 5 and 1440),
  order_cutoff_minutes    integer not null default 30  check (order_cutoff_minutes between 0 and 720),
  max_items_per_order     integer not null default 20  check (max_items_per_order between 1 and 200),
  max_qty_per_item        integer not null default 5   check (max_qty_per_item between 1 and 99),
  fee_type                text check (fee_type in ('percent', 'flat')),        -- null = use the business plan fee
  fee_value               numeric(10,2) check (fee_value is null or fee_value >= 0),   -- percent, or dollars when flat
  fee_waived              boolean not null default false,
  first_order_fee_waiver  boolean not null default false,
  allowed_payment_modes   text[] not null default array['pay_at_pickup'],
  updated_at              timestamptz not null default now(),
  constraint sf_defaults_fee_pair check ((fee_type is null) = (fee_value is null)),
  constraint sf_defaults_percent_cap check (fee_type is distinct from 'percent' or fee_value <= 100),
  constraint sf_defaults_modes check (allowed_payment_modes <@ array['pay_at_pickup', 'prepay_card'] and 'pay_at_pickup' = any (allowed_payment_modes))
);
alter table public.business_storefront_defaults enable row level security;
revoke all on public.business_storefront_defaults from anon, authenticated;
grant select on public.business_storefront_defaults to authenticated;
drop policy if exists sf_defaults_select on public.business_storefront_defaults;
create policy sf_defaults_select on public.business_storefront_defaults for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.sf_can('storefront.view'));
drop trigger if exists trg_sf_defaults_touch on public.business_storefront_defaults;
create trigger trg_sf_defaults_touch before update on public.business_storefront_defaults for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- per-location settings
create table if not exists public.storefront_settings (
  location_id             uuid primary key,
  tenant_id               uuid not null,
  enabled                 boolean not null default false,
  paused                  boolean not null default false,
  pause_reason            text check (char_length(pause_reason) <= 200),
  inventory_mode          text not null default 'curated' check (inventory_mode in ('pos_sync', 'curated')),
  pickup_hours            jsonb,                          -- {mon:{open:"10:00",close:"21:00",closed:false},...}; null = no hours limit
  pickup_instructions     text check (char_length(pickup_instructions) <= 500),
  hold_minutes            integer check (hold_minutes between 5 and 1440),             -- null = inherit
  order_cutoff_minutes    integer check (order_cutoff_minutes between 0 and 720),
  max_items_per_order     integer check (max_items_per_order between 1 and 200),
  max_qty_per_item        integer check (max_qty_per_item between 1 and 99),
  payment_mode            text not null default 'pay_at_pickup' check (payment_mode in ('pay_at_pickup', 'prepay_card')),
  require_id_at_pickup    boolean not null default true,
  auto_cancel_no_show     boolean not null default true,
  notify_inapp            boolean not null default true,
  notify_email            boolean not null default true,
  notify_sms              boolean not null default false,   -- only honoured when SMS_ENABLED
  updated_at              timestamptz not null default now()
);
create index if not exists idx_sf_settings_tenant on public.storefront_settings (tenant_id);
alter table public.storefront_settings enable row level security;
revoke all on public.storefront_settings from anon, authenticated;
grant select on public.storefront_settings to authenticated;
drop policy if exists sf_settings_select on public.storefront_settings;
create policy sf_settings_select on public.storefront_settings for select to authenticated
  using ((tenant_id = public.current_tenant_id() and public.sf_can('storefront.view')) or public.sf_pos_at(location_id));
drop trigger if exists trg_sf_settings_touch on public.storefront_settings;
create trigger trg_sf_settings_touch before update on public.storefront_settings for each row execute function public.set_updated_at();

-- Keep the public location gate (locations.is_storefront_enabled) in step with the manager's switch.
create or replace function public.sf_sync_location_gate()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.locations set is_storefront_enabled = new.enabled where id = new.location_id and is_storefront_enabled is distinct from new.enabled;
  return new;
end;
$$;
drop trigger if exists trg_sf_settings_gate on public.storefront_settings;
create trigger trg_sf_settings_gate after insert or update of enabled on public.storefront_settings for each row execute function public.sf_sync_location_gate();

-- Resolved values: location override, else business default.
create or replace function public.sf_effective_settings(p_location uuid)
returns table (hold_minutes integer, order_cutoff_minutes integer, max_items_per_order integer, max_qty_per_item integer)
language sql stable security definer set search_path = public as $$
  select coalesce(s.hold_minutes, d.hold_minutes, 60), coalesce(s.order_cutoff_minutes, d.order_cutoff_minutes, 30),
         coalesce(s.max_items_per_order, d.max_items_per_order, 20), coalesce(s.max_qty_per_item, d.max_qty_per_item, 5)
    from public.storefront_settings s
    left join public.business_storefront_defaults d on d.tenant_id = s.tenant_id
   where s.location_id = p_location;
$$;
revoke all on function public.sf_effective_settings(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- items
create table if not exists public.storefront_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  location_id    uuid not null,
  source         text not null check (source in ('pos', 'curated')),
  pos_product_id text,                       -- POS barcode when source = 'pos'
  name           text,
  brand          text,
  flavor         text,
  size           text,
  price          numeric(12,2) check (price is null or (price >= 0 and price < 100000)),
  image_url      text,
  category       text,
  status         text not null default 'available' check (status in ('available', 'sold_out', 'hidden')),
  qty            integer check (qty is null or qty >= 0),
  sort_order     integer not null default 0,
  updated_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint sf_items_pos_ref check (source <> 'pos' or pos_product_id is not null),
  constraint sf_items_curated_fields check (source <> 'curated' or (name is not null and char_length(trim(name)) > 0 and price is not null))
);
create unique index if not exists uq_sf_items_pos on public.storefront_items (location_id, pos_product_id) where source = 'pos';
create index if not exists idx_sf_items_loc on public.storefront_items (location_id, sort_order);
alter table public.storefront_items enable row level security;
revoke all on public.storefront_items from anon, authenticated;
grant select, insert, update, delete on public.storefront_items to authenticated;

drop policy if exists sf_items_select on public.storefront_items;
create policy sf_items_select on public.storefront_items for select to authenticated
  using ((tenant_id = public.current_tenant_id() and public.sf_can('storefront.view')) or public.sf_pos_at(location_id));
drop policy if exists sf_items_write on public.storefront_items;
create policy sf_items_write on public.storefront_items for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.sf_can('storefront.items.edit'))
  with check (tenant_id = public.current_tenant_id() and public.sf_can('storefront.items.edit')
              and tenant_id = public.sf_location_tenant(location_id));

-- Mode and source rules, POS read-only fields, audit of who changed it.
create or replace function public.sf_items_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_mode text;
begin
  select inventory_mode into v_mode from public.storefront_settings where location_id = new.location_id;
  v_mode := coalesce(v_mode, 'curated');
  if tg_op = 'INSERT' then
    if new.source = 'pos' and v_mode <> 'pos_sync' then raise exception 'pos_items_not_allowed_in_curated_mode'; end if;
    if new.source = 'curated' and v_mode <> 'curated' then raise exception 'curated_items_not_allowed_in_pos_mode'; end if;
    if new.source = 'pos' and not exists (select 1 from public.inventory_cloud i
         where i.tenant_id = new.tenant_id and i.location_id = new.location_id and i.barcode = new.pos_product_id) then
      raise exception 'pos_product_not_found';
    end if;
    -- POS items carry no copy of name/price/qty: those are read live from the POS inventory
    if new.source = 'pos' then new.name := null; new.price := null; new.qty := null; end if;
  else
    if new.tenant_id <> old.tenant_id or new.location_id <> old.location_id or new.source <> old.source
       or new.pos_product_id is distinct from old.pos_product_id then
      raise exception 'item_identity_is_immutable';
    end if;
    if old.source = 'pos' and (new.name is distinct from old.name or new.price is distinct from old.price or new.qty is distinct from old.qty
                               or new.brand is distinct from old.brand or new.flavor is distinct from old.flavor or new.size is distinct from old.size) then
      raise exception 'pos_item_read_only';
    end if;
  end if;
  new.updated_by := public.sf_employee_uid();
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_sf_items_guard on public.storefront_items;
create trigger trg_sf_items_guard before insert or update on public.storefront_items for each row execute function public.sf_items_guard();

-- ---------------------------------------------------------------- "menu changed" signal for realtime
-- The customer storefront subscribes to this tiny table (anon-readable, reveals nothing but a counter)
-- and re-fetches the menu when it changes: a sold-out tap reaches customers within seconds.
create table if not exists public.storefront_menu_version (
  location_id uuid primary key,
  version     bigint not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.storefront_menu_version enable row level security;
revoke all on public.storefront_menu_version from anon, authenticated;
grant select on public.storefront_menu_version to anon, authenticated;
drop policy if exists sf_menu_version_read on public.storefront_menu_version;
create policy sf_menu_version_read on public.storefront_menu_version for select to anon, authenticated using (true);

create or replace function public.sf_bump_menu(p_location uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.storefront_menu_version (location_id, version) values (p_location, 1)
  on conflict (location_id) do update set version = public.storefront_menu_version.version + 1, updated_at = now();
$$;
revoke all on function public.sf_bump_menu(uuid) from public, anon, authenticated;

create or replace function public.sf_bump_menu_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sf_bump_menu(coalesce(new.location_id, old.location_id));
  return coalesce(new, old);
end;
$$;
drop trigger if exists trg_sf_items_bump on public.storefront_items;
create trigger trg_sf_items_bump after insert or update or delete on public.storefront_items for each row execute function public.sf_bump_menu_trg();
drop trigger if exists trg_sf_settings_bump on public.storefront_settings;
create trigger trg_sf_settings_bump after insert or update on public.storefront_settings for each row execute function public.sf_bump_menu_trg();

-- Realtime publication (exists on Supabase; skipped on a plain Postgres test database).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.storefront_menu_version;
    alter publication supabase_realtime add table public.storefront_items;
  end if;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------- settings RPCs (the only write path)
create or replace function public.sf_ensure_settings(p_location uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.sf_location_tenant(p_location); v_plan text;
begin
  if v_tenant is null or v_tenant <> public.current_tenant_id() then raise exception 'forbidden' using errcode = '42501'; end if;
  select plan_type into v_plan from public.licenses where tenant_id = v_tenant and kind = 'business' limit 1;
  insert into public.storefront_settings (location_id, tenant_id, inventory_mode)
  values (p_location, v_tenant, case when v_plan = 'model_a' then 'pos_sync' else 'curated' end)
  on conflict (location_id) do nothing;
end;
$$;
revoke all on function public.sf_ensure_settings(uuid) from public, anon;
grant execute on function public.sf_ensure_settings(uuid) to authenticated;

-- Location-level settings a manager with storefront.settings.edit may change.
create or replace function public.sf_save_settings(p_location uuid, p_patch jsonb)
returns public.storefront_settings
language plpgsql security definer set search_path = public as $$
declare r public.storefront_settings; v_prepay boolean; v_defaults public.business_storefront_defaults;
begin
  if not public.sf_can('storefront.settings.edit') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.sf_ensure_settings(p_location);
  select coalesce((value ->> 'enabled')::boolean, false) into v_prepay from public.app_config where key = 'storefront_prepay';
  select * into v_defaults from public.business_storefront_defaults where tenant_id = public.current_tenant_id();

  if p_patch ? 'payment_mode' and p_patch ->> 'payment_mode' = 'prepay_card' then
    if not coalesce(v_prepay, false) then raise exception 'prepay_not_available'; end if;
    if v_defaults.tenant_id is not null and not ('prepay_card' = any (v_defaults.allowed_payment_modes)) then raise exception 'payment_mode_not_allowed'; end if;
  end if;
  if p_patch ? 'enabled' and (p_patch ->> 'enabled')::boolean and v_defaults.tenant_id is not null and not v_defaults.storefront_enabled then
    raise exception 'storefront_disabled_by_owner';
  end if;

  update public.storefront_settings set
    enabled              = case when p_patch ? 'enabled' then (p_patch ->> 'enabled')::boolean else enabled end,
    paused               = case when p_patch ? 'paused' then (p_patch ->> 'paused')::boolean else paused end,
    pause_reason         = case when p_patch ? 'pause_reason' then nullif(left(p_patch ->> 'pause_reason', 200), '') else pause_reason end,
    pickup_hours         = case when p_patch ? 'pickup_hours' then p_patch -> 'pickup_hours' else pickup_hours end,
    pickup_instructions  = case when p_patch ? 'pickup_instructions' then nullif(left(p_patch ->> 'pickup_instructions', 500), '') else pickup_instructions end,
    hold_minutes         = case when p_patch ? 'hold_minutes' then nullif(p_patch ->> 'hold_minutes', '')::integer else hold_minutes end,
    order_cutoff_minutes = case when p_patch ? 'order_cutoff_minutes' then nullif(p_patch ->> 'order_cutoff_minutes', '')::integer else order_cutoff_minutes end,
    max_items_per_order  = case when p_patch ? 'max_items_per_order' then nullif(p_patch ->> 'max_items_per_order', '')::integer else max_items_per_order end,
    max_qty_per_item     = case when p_patch ? 'max_qty_per_item' then nullif(p_patch ->> 'max_qty_per_item', '')::integer else max_qty_per_item end,
    payment_mode         = case when p_patch ? 'payment_mode' then p_patch ->> 'payment_mode' else payment_mode end,
    require_id_at_pickup = case when p_patch ? 'require_id_at_pickup' then (p_patch ->> 'require_id_at_pickup')::boolean else require_id_at_pickup end,
    auto_cancel_no_show  = case when p_patch ? 'auto_cancel_no_show' then (p_patch ->> 'auto_cancel_no_show')::boolean else auto_cancel_no_show end,
    notify_inapp         = case when p_patch ? 'notify_inapp' then (p_patch ->> 'notify_inapp')::boolean else notify_inapp end,
    notify_email         = case when p_patch ? 'notify_email' then (p_patch ->> 'notify_email')::boolean else notify_email end,
    notify_sms           = case when p_patch ? 'notify_sms' then (p_patch ->> 'notify_sms')::boolean else notify_sms end
  where location_id = p_location and tenant_id = public.current_tenant_id()
  returning * into r;
  if r.location_id is null then raise exception 'location_not_found'; end if;
  return r;
end;
$$;

-- The pause switch is a dashboard button: needs only orders.manage, not settings.edit.
create or replace function public.sf_set_paused(p_location uuid, p_paused boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sf_can('storefront.orders.manage') then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.sf_ensure_settings(p_location);
  update public.storefront_settings set paused = p_paused, pause_reason = case when p_paused then nullif(left(p_reason, 200), '') else null end
   where location_id = p_location and tenant_id = public.current_tenant_id();
end;
$$;

-- Business-level controls: owner only (Owner Console token).
create or replace function public.sf_owner_save_defaults(p_patch jsonb)
returns public.business_storefront_defaults
language plpgsql security definer set search_path = public as $$
declare r public.business_storefront_defaults; v_prepay boolean; v_modes text[];
begin
  if not public.sf_is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.business_storefront_defaults (tenant_id) values (public.current_tenant_id()) on conflict (tenant_id) do nothing;
  if p_patch ? 'allowed_payment_modes' then
    select array_agg(distinct x) into v_modes from jsonb_array_elements_text(p_patch -> 'allowed_payment_modes') x;
    select coalesce((value ->> 'enabled')::boolean, false) into v_prepay from public.app_config where key = 'storefront_prepay';
    if 'prepay_card' = any (v_modes) and not coalesce(v_prepay, false) then raise exception 'prepay_not_available'; end if;
  end if;
  update public.business_storefront_defaults set
    storefront_enabled     = case when p_patch ? 'storefront_enabled' then (p_patch ->> 'storefront_enabled')::boolean else storefront_enabled end,
    hold_minutes           = case when p_patch ? 'hold_minutes' then (p_patch ->> 'hold_minutes')::integer else hold_minutes end,
    order_cutoff_minutes   = case when p_patch ? 'order_cutoff_minutes' then (p_patch ->> 'order_cutoff_minutes')::integer else order_cutoff_minutes end,
    max_items_per_order    = case when p_patch ? 'max_items_per_order' then (p_patch ->> 'max_items_per_order')::integer else max_items_per_order end,
    max_qty_per_item       = case when p_patch ? 'max_qty_per_item' then (p_patch ->> 'max_qty_per_item')::integer else max_qty_per_item end,
    fee_type               = case when p_patch ? 'fee_type' then nullif(p_patch ->> 'fee_type', '') else fee_type end,
    fee_value              = case when p_patch ? 'fee_value' then nullif(p_patch ->> 'fee_value', '')::numeric else fee_value end,
    fee_waived             = case when p_patch ? 'fee_waived' then (p_patch ->> 'fee_waived')::boolean else fee_waived end,
    first_order_fee_waiver = case when p_patch ? 'first_order_fee_waiver' then (p_patch ->> 'first_order_fee_waiver')::boolean else first_order_fee_waiver end,
    allowed_payment_modes  = case when p_patch ? 'allowed_payment_modes' then (select array_agg(distinct x) || case when 'pay_at_pickup' = any (array_agg(distinct x)) then '{}' else array['pay_at_pickup'] end from jsonb_array_elements_text(p_patch -> 'allowed_payment_modes') x) else allowed_payment_modes end
  where tenant_id = public.current_tenant_id()
  returning * into r;
  -- turning the business switch off switches every location off at once
  if p_patch ? 'storefront_enabled' and not (p_patch ->> 'storefront_enabled')::boolean then
    update public.storefront_settings set enabled = false where tenant_id = r.tenant_id;
  end if;
  return r;
end;
$$;

-- Owner sets POS-sync vs curated per location (changing mode does not delete items; incompatible ones are hidden).
create or replace function public.sf_owner_set_inventory_mode(p_location uuid, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sf_is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_mode not in ('pos_sync', 'curated') then raise exception 'mode_invalid'; end if;
  perform public.sf_ensure_settings(p_location);
  update public.storefront_settings set inventory_mode = p_mode where location_id = p_location and tenant_id = public.current_tenant_id();
  -- items of the other source stay in the table but are hidden from customers
  update public.storefront_items set status = 'hidden'
   where location_id = p_location and tenant_id = public.current_tenant_id()
     and source <> case when p_mode = 'pos_sync' then 'pos' else 'curated' end and status <> 'hidden';
end;
$$;

-- Permission toggles (owner, or an admin-role employee). Every change is written to the append-only override log.
create or replace function public.sf_set_permission(p_employee uuid, p_key text, p_granted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); v_name text; v_actor text; v_existing uuid;
begin
  if not (public.sf_is_owner() or public.sf_is_admin_role()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key not in ('storefront.view', 'storefront.items.edit', 'storefront.orders.manage', 'storefront.settings.edit', 'storefront.reports.view', 'storefront.fees.view') then
    raise exception 'permission_key_invalid';
  end if;
  select name into v_name from public.employees_cloud where tenant_id = v_tenant and uid = p_employee;
  if v_name is null and not exists (select 1 from public.employees_cloud where tenant_id = v_tenant and uid = p_employee) then raise exception 'employee_not_found'; end if;
  select uid into v_existing from public.employee_permissions_cloud where tenant_id = v_tenant and employee_uid = p_employee and permission_key = p_key limit 1;
  if v_existing is null then
    insert into public.employee_permissions_cloud (uid, tenant_id, employee_uid, permission_key, is_granted) values (gen_random_uuid(), v_tenant, p_employee, p_key, p_granted);
  else
    update public.employee_permissions_cloud set is_granted = p_granted where tenant_id = v_tenant and uid = v_existing;
  end if;
  select coalesce(name, username) into v_actor from public.employees_cloud where tenant_id = v_tenant and uid = public.sf_employee_uid();
  insert into public.permission_override_log_cloud (uid, tenant_id, at, acting_employee_uid, acting_employee_name, action_attempted, required_permission,
                                                    authorizing_manager_uid, authorizing_manager_name, was_approved, event_type)
  values (gen_random_uuid(), v_tenant, now(), p_employee, v_name,
          case when p_granted then 'grant ' else 'revoke ' end || p_key, p_key,
          public.sf_employee_uid(), coalesce(v_actor, case when public.sf_is_owner() then 'Owner Console' end), true, 'storefront_permission');
end;
$$;

revoke all on function public.sf_save_settings(uuid, jsonb), public.sf_set_paused(uuid, boolean, text), public.sf_owner_save_defaults(jsonb),
  public.sf_owner_set_inventory_mode(uuid, text), public.sf_set_permission(uuid, text, boolean) from public, anon;
grant execute on function public.sf_save_settings(uuid, jsonb), public.sf_set_paused(uuid, boolean, text), public.sf_owner_save_defaults(jsonb),
  public.sf_owner_set_inventory_mode(uuid, text), public.sf_set_permission(uuid, text, boolean) to authenticated;
revoke all on function public.sf_can(text), public.sf_is_admin_role(), public.sf_pos_at(uuid), public.sf_location_tenant(uuid) from public, anon;
grant execute on function public.sf_can(text), public.sf_is_admin_role(), public.sf_pos_at(uuid), public.sf_location_tenant(uuid), public.sf_is_owner(), public.sf_employee_uid() to authenticated;
-- anon evaluates RLS policies on tables it can read; these helpers must be callable but reveal nothing
grant execute on function public.sf_is_owner(), public.sf_employee_uid() to anon;

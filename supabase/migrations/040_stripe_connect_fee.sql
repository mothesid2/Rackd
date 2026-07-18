-- 040_stripe_connect_fee.sql
-- Stripe Connect (Express, per-location) + the 5% online order fee (items 7 & 8).
--
-- Money model: each LOCATION has its own Stripe Express account. Online checkout is
-- a destination charge — the customer is charged (items + tax + a 5% online fee),
-- the 5% routes to the PLATFORM as the application fee, and the remainder settles to
-- the location's connected account (which bears Stripe's processing fee via
-- on_behalf_of — set in the storefront-checkout function). A location can only be
-- storefront-enabled once its Express onboarding is complete.

-- ── per-location Connect state ───────────────────────────────────────────────
alter table public.locations add column if not exists stripe_account_id text;
alter table public.locations add column if not exists stripe_onboarding_complete boolean not null default false;

-- ── the online order fee (item 8): a separate, itemized line, 5% of item subtotal ─
alter table public.online_orders add column if not exists online_fee numeric(12,2) not null default 0;

-- ── reserve_online_order: add the 5% fee to the total + gate on onboarding ────
-- total = subtotal + tax + online_fee. online_fee = 5% of the item subtotal (on TOP
-- of item price, not absorbed). A location must be storefront-enabled AND onboarded.
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
  v_taxrate numeric(6,4); v_tax numeric(12,2); v_fee numeric(12,2);
  v_onboarded boolean;
  c_fee_rate constant numeric := 0.05; -- 5% online order fee (platform application fee)
begin
  if v_cust is null then raise exception 'not authenticated'; end if;

  select * into v_prof from public.storefront_customers where id = v_cust;
  if v_prof.id is null or v_prof.age_verified is not true
     or v_prof.age_verified_at is null
     or v_prof.age_verified_at < now() - make_interval(days => p_reverify_days) then
    raise exception 'age_verification_required';
  end if;

  -- Location must be online AND have completed Stripe Express onboarding.
  select coalesce(tax_rate, 0), coalesce(stripe_onboarding_complete, false)
    into v_taxrate, v_onboarded
    from public.locations where id = p_location and is_storefront_enabled;
  if v_taxrate is null then raise exception 'location_not_available'; end if;
  if v_onboarded is not true then raise exception 'location_not_available'; end if;

  v_order := gen_random_uuid();
  insert into public.online_orders (id, order_number, tenant_id, location_id, customer_id, status)
    values (v_order, upper(substr(v_order::text, 1, 8)), p_tenant, p_location, v_cust, 'pending_payment');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_barcode := v_item ->> 'barcode';
    v_qty := greatest(1, coalesce((v_item ->> 'qty')::int, 1));
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

  v_tax := round(v_subtotal * v_taxrate, 2);
  v_fee := round(v_subtotal * c_fee_rate, 2);
  update public.online_orders
     set subtotal = v_subtotal, tax = v_tax, online_fee = v_fee, total = v_subtotal + v_tax + v_fee
   where id = v_order;
  return v_order;
end;
$$;

-- ── set_storefront_settings: block enabling until onboarding is complete ──────
create or replace function public.set_storefront_settings(
  p_location uuid, p_enabled boolean, p_tax_rate numeric default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;

  -- Gate: turning the storefront ON requires a completed Stripe Express onboarding.
  if coalesce(p_enabled, false) then
    if not exists (
      select 1 from public.locations
       where id = p_location and tenant_id = public.current_tenant_id() and stripe_onboarding_complete
    ) then
      raise exception 'stripe_onboarding_required';
    end if;
  end if;

  update public.locations
     set is_storefront_enabled = coalesce(p_enabled, is_storefront_enabled),
         tax_rate = coalesce(p_tax_rate, tax_rate)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;

  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_settings(uuid, boolean, numeric) from public, anon;
grant execute on function public.set_storefront_settings(uuid, boolean, numeric) to authenticated;

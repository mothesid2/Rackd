-- 050_tax_on_surcharge.sql
--
-- Reverses 040's fee/tax model per updated direction: checkout now itemizes FOUR
-- lines — subtotal, tax on the subtotal, the 5% online-order surcharge, and tax
-- on that surcharge (not just tax on the subtotal with the surcharge left
-- untaxed). Each tax amount is computed and rounded against its own base
-- separately (not against the combined subtotal+fee), so the two roundings can
-- differ by a cent from a single combined-base calculation — that's expected.
--
-- total = subtotal + tax + online_fee + fee_tax

alter table public.online_orders add column if not exists fee_tax numeric(12,2) not null default 0;

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
  v_taxrate numeric(6,4); v_tax numeric(12,2); v_fee numeric(12,2); v_fee_tax numeric(12,2);
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

  -- Four line items: subtotal, tax on the subtotal, the surcharge, and tax on
  -- the surcharge — each tax computed (and rounded) against its own base.
  v_tax := round(v_subtotal * v_taxrate, 2);
  v_fee := round(v_subtotal * c_fee_rate, 2);
  v_fee_tax := round(v_fee * v_taxrate, 2);
  update public.online_orders
     set subtotal = v_subtotal, tax = v_tax, online_fee = v_fee, fee_tax = v_fee_tax,
         total = v_subtotal + v_tax + v_fee + v_fee_tax
   where id = v_order;
  return v_order;
end;
$$;

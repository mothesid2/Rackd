-- 089: hardware order creation and guest lookup. Reverse with supabase/down/089_down.sql.
-- The server computes every price from the catalog; these functions only persist and cross-check the
-- arithmetic. Service-role only, except hw_order_tenant which lets the server verify a logged-in owner.

alter table public.hardware_orders add column if not exists discount_cents integer not null default 0 check (discount_cents >= 0);

-- Called with the caller's own JWT: PostgREST verifies the signature, we just read the tenant claim.
create or replace function public.hw_order_tenant()
returns uuid
language sql stable
as $$ select public.current_tenant_id(); $$;
revoke all on function public.hw_order_tenant() from public, anon;
grant execute on function public.hw_order_tenant() to authenticated, service_role;

create or replace function public.hw_create_order(
  p_email text, p_application_id uuid, p_tenant_id uuid, p_address jsonb, p_method text,
  p_subtotal integer, p_discount integer, p_shipping integer, p_tax integer, p_total integer,
  p_notes text, p_is_test boolean, p_token_hash text, p_items jsonb)
returns table (order_id uuid, order_number text)
language plpgsql security definer
set search_path = public
as $$
declare
  v_addr uuid; v_order uuid; v_num text; v_sum integer;
begin
  if p_email is null or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email_invalid'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'cart_empty'; end if;
  select coalesce(sum((i ->> 'unit_price_cents')::integer * (i ->> 'quantity')::integer), 0)
    into v_sum from jsonb_array_elements(p_items) i;
  if v_sum <> p_subtotal then raise exception 'subtotal_mismatch'; end if;
  if p_subtotal - p_discount + p_shipping + p_tax <> p_total then raise exception 'total_mismatch'; end if;
  if coalesce(trim(p_address ->> 'full_name'), '') = '' or coalesce(trim(p_address ->> 'line1'), '') = ''
     or coalesce(trim(p_address ->> 'city'), '') = '' or coalesce(trim(p_address ->> 'state'), '') = ''
     or coalesce(trim(p_address ->> 'zip'), '') = '' then
    raise exception 'address_incomplete';
  end if;

  insert into public.shipping_addresses (full_name, company, line1, line2, city, state, zip, phone)
  values (trim(p_address ->> 'full_name'), nullif(trim(p_address ->> 'company'), ''), trim(p_address ->> 'line1'),
          nullif(trim(p_address ->> 'line2'), ''), trim(p_address ->> 'city'), upper(trim(p_address ->> 'state')),
          trim(p_address ->> 'zip'), nullif(trim(p_address ->> 'phone'), ''))
  returning id into v_addr;

  insert into public.hardware_orders
    (email, application_id, tenant_id, shipping_address_id, shipping_method, subtotal_cents, discount_cents,
     shipping_cents, tax_cents, total_cents, notes, is_test, access_token_hash)
  values (lower(trim(p_email)), p_application_id, p_tenant_id, v_addr, p_method, p_subtotal, p_discount,
          p_shipping, p_tax, p_total, left(nullif(trim(p_notes), ''), 1000), coalesce(p_is_test, true), p_token_hash)
  returning id, hardware_orders.order_number into v_order, v_num;

  insert into public.hardware_order_items (order_id, product_id, name_snapshot, sku_snapshot, unit_price_cents, quantity)
  select v_order, nullif(i ->> 'product_id', '')::uuid, i ->> 'name', i ->> 'sku',
         (i ->> 'unit_price_cents')::integer, (i ->> 'quantity')::integer
    from jsonb_array_elements(p_items) i;

  return query select v_order, v_num;
end;
$$;

-- Guest order page: the access token (hashed by the caller) is the credential.
create or replace function public.hw_get_order(p_id uuid, p_token_hash text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare o public.hardware_orders; a public.shipping_addresses;
begin
  select * into o from public.hardware_orders
   where id = p_id and access_token_hash is not null and access_token_hash = p_token_hash;
  if o.id is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  select * into a from public.shipping_addresses where id = o.shipping_address_id;
  return jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'status', o.status, 'email', o.email,
    'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'shipping_cents', o.shipping_cents,
    'tax_cents', o.tax_cents, 'total_cents', o.total_cents, 'currency', o.currency, 'is_test', o.is_test,
    'notes', o.notes, 'shipping_method', o.shipping_method, 'carrier', o.carrier, 'tracking_number', o.tracking_number,
    'created_at', o.created_at, 'paid_at', o.paid_at, 'shipped_at', o.shipped_at,
    'address', jsonb_build_object('full_name', a.full_name, 'company', a.company, 'line1', a.line1, 'line2', a.line2,
                                  'city', a.city, 'state', a.state, 'zip', a.zip),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name_snapshot, 'sku', i.sku_snapshot,
                'unit_price_cents', i.unit_price_cents, 'quantity', i.quantity) order by i.name_snapshot)
              from public.hardware_order_items i where i.order_id = o.id), '[]'::jsonb));
end;
$$;

revoke all on function public.hw_create_order(text, uuid, uuid, jsonb, text, integer, integer, integer, integer, integer, text, boolean, text, jsonb) from public, anon, authenticated;
revoke all on function public.hw_get_order(uuid, text) from public, anon, authenticated;
grant execute on function public.hw_create_order(text, uuid, uuid, jsonb, text, integer, integer, integer, integer, integer, text, boolean, text, jsonb) to service_role;
grant execute on function public.hw_get_order(uuid, text) to service_role;

-- 090: payment state for hardware orders (Stripe webhook support). Reverse with supabase/down/090_down.sql.
-- All functions are service-role only. Stripe is used for Rackd's own hardware charges only.

alter table public.hardware_orders add column if not exists email_token_hash text unique;

-- Guest lookup now accepts the browser token OR the token emailed in the confirmation.
create or replace function public.hw_get_order(p_id uuid, p_token_hash text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare o public.hardware_orders; a public.shipping_addresses;
begin
  select * into o from public.hardware_orders
   where id = p_id and p_token_hash is not null
     and (access_token_hash = p_token_hash or email_token_hash = p_token_hash);
  if o.id is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  select * into a from public.shipping_addresses where id = o.shipping_address_id;
  return jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'status', o.status, 'email', o.email,
    'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'shipping_cents', o.shipping_cents,
    'tax_cents', o.tax_cents, 'total_cents', o.total_cents, 'currency', o.currency, 'is_test', o.is_test,
    'notes', o.notes, 'shipping_method', o.shipping_method, 'carrier', o.carrier, 'tracking_number', o.tracking_number,
    'created_at', o.created_at, 'paid_at', o.paid_at, 'shipped_at', o.shipped_at,
    'stripe_session_id', o.stripe_session_id,
    'address', jsonb_build_object('full_name', a.full_name, 'company', a.company, 'line1', a.line1, 'line2', a.line2,
                                  'city', a.city, 'state', a.state, 'zip', a.zip),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name_snapshot, 'sku', i.sku_snapshot,
                'unit_price_cents', i.unit_price_cents, 'quantity', i.quantity) order by i.name_snapshot)
              from public.hardware_order_items i where i.order_id = o.id), '[]'::jsonb));
end;
$$;

create or replace function public.hw_set_session(p_order uuid, p_session text)
returns void
language sql security definer
set search_path = public
as $$
  update public.hardware_orders set stripe_session_id = p_session where id = p_order and status = 'pending';
$$;

create or replace function public.hw_issue_email_token(p_order uuid, p_hash text)
returns void
language sql security definer
set search_path = public
as $$
  update public.hardware_orders set email_token_hash = p_hash where id = p_order;
$$;

-- Webhook idempotency: 'new' (first sight), 'retry' (seen but never finished), 'done' (already processed).
create or replace function public.hw_event_begin(p_id text, p_type text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare v_done timestamptz; v_rows integer;
begin
  insert into public.stripe_events (event_id, type) values (p_id, p_type) on conflict (event_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then return 'new'; end if;
  select processed_at into v_done from public.stripe_events where event_id = p_id;
  return case when v_done is null then 'retry' else 'done' end;
end;
$$;

create or replace function public.hw_event_done(p_id text)
returns void
language sql security definer
set search_path = public
as $$
  update public.stripe_events set processed_at = now() where event_id = p_id and processed_at is null;
$$;

-- Marks an order paid exactly once and decrements stock in the same transaction. Safe to call twice.
create or replace function public.hw_mark_paid(
  p_order uuid, p_session text, p_payment_intent text, p_amount_total integer, p_amount_tax integer, p_livemode boolean)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  o public.hardware_orders; i record; v_stock integer; v_oversold text[] := '{}'; v_changed_amount boolean := false;
begin
  select * into o from public.hardware_orders where id = p_order for update;
  if o.id is null then raise exception 'order_not_found'; end if;
  if o.stripe_session_id is not null and o.stripe_session_id <> p_session then
    -- a different Checkout Session than the one we issued for this order
    raise exception 'session_mismatch';
  end if;
  if o.is_test = p_livemode then raise exception 'mode_mismatch'; end if;  -- is_test must be the opposite of livemode

  if o.status <> 'pending' then
    return jsonb_build_object('changed', false, 'status', o.status, 'order_number', o.order_number, 'email', o.email, 'is_test', o.is_test);
  end if;

  if p_amount_total is not null and p_amount_total <> o.total_cents then
    v_changed_amount := true;
    update public.hardware_orders
       set tax_cents = coalesce(p_amount_tax, tax_cents), total_cents = p_amount_total
     where id = o.id;
  end if;

  for i in select product_id, name_snapshot, sku_snapshot, quantity from public.hardware_order_items where order_id = o.id loop
    if i.product_id is null then continue; end if;
    select stock_qty into v_stock from public.hardware_products where id = i.product_id for update;
    if v_stock < i.quantity then v_oversold := v_oversold || coalesce(i.sku_snapshot, i.name_snapshot); end if;
    update public.hardware_products set stock_qty = greatest(0, stock_qty - i.quantity) where id = i.product_id;
  end loop;

  update public.hardware_orders
     set status = 'paid', paid_at = now(), stripe_payment_intent = p_payment_intent, stripe_session_id = coalesce(stripe_session_id, p_session),
         notes = case when array_length(v_oversold, 1) is null then notes
                      else left(coalesce(notes || E'\n', '') || '[system] Oversold at payment: ' || array_to_string(v_oversold, ', '), 1000) end
   where id = o.id;
  perform public.write_audit('hardware_order.paid', 'hardware_orders', o.id::text,
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'paid', 'oversold', to_jsonb(v_oversold), 'amount_changed', v_changed_amount), null);

  return jsonb_build_object('changed', true, 'status', 'paid', 'order_number', o.order_number, 'email', o.email, 'is_test', o.is_test,
                            'oversold', to_jsonb(v_oversold), 'amount_changed', v_changed_amount, 'order_id', o.id);
end;
$$;

-- Full refund flips the order; partial refunds only leave a note. Stock is not restocked automatically.
create or replace function public.hw_mark_refunded(p_payment_intent text, p_full boolean, p_note text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare o public.hardware_orders;
begin
  select * into o from public.hardware_orders where stripe_payment_intent = p_payment_intent for update;
  if o.id is null then return jsonb_build_object('changed', false, 'found', false); end if;
  update public.hardware_orders
     set status = case when p_full and status in ('paid', 'fulfilled', 'shipped') then 'refunded' else status end,
         refund_note = left(coalesce(refund_note || E'\n', '') || coalesce(p_note, 'refund recorded by Stripe'), 1000)
   where id = o.id;
  perform public.write_audit('hardware_order.refund', 'hardware_orders', o.id::text,
    jsonb_build_object('status', o.status), jsonb_build_object('full', p_full, 'note', p_note), null);
  return jsonb_build_object('changed', p_full and o.status in ('paid', 'fulfilled', 'shipped'), 'found', true, 'order_number', o.order_number, 'order_id', o.id);
end;
$$;

revoke all on function
  public.hw_get_order(uuid, text), public.hw_set_session(uuid, text), public.hw_issue_email_token(uuid, text),
  public.hw_event_begin(text, text), public.hw_event_done(text),
  public.hw_mark_paid(uuid, text, text, integer, integer, boolean), public.hw_mark_refunded(text, boolean, text)
  from public, anon, authenticated;
grant execute on function
  public.hw_get_order(uuid, text), public.hw_set_session(uuid, text), public.hw_issue_email_token(uuid, text),
  public.hw_event_begin(text, text), public.hw_event_done(text),
  public.hw_mark_paid(uuid, text, text, integer, integer, boolean), public.hw_mark_refunded(text, boolean, text)
  to service_role;

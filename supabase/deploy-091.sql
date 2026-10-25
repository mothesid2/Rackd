-- 091: platform admin console support. Reverse with supabase/down/091_down.sql.

-- Lets a Pages Function verify "is this bearer token a platform admin, and who?" using the caller's own JWT.
create or replace function public.admin_whoami()
returns uuid
language sql stable security definer
set search_path = public
as $$ select case when public.is_platform_admin() then auth.uid() end; $$;
revoke all on function public.admin_whoami() from public, anon;
grant execute on function public.admin_whoami() to authenticated, service_role;

-- ---------------------------------------------------------------- hardware order transitions (admin, via server)
create or replace function public.hw_admin_transition(
  p_order uuid, p_to text, p_carrier text, p_tracking text, p_note text, p_actor uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare o public.hardware_orders; i record;
begin
  select * into o from public.hardware_orders where id = p_order for update;
  if o.id is null then raise exception 'order_not_found'; end if;

  if p_to = 'fulfilled' then
    if o.status <> 'paid' then raise exception 'invalid_transition: % -> fulfilled', o.status; end if;
  elsif p_to = 'shipped' then
    if o.status not in ('paid', 'fulfilled') then raise exception 'invalid_transition: % -> shipped', o.status; end if;
    if coalesce(trim(p_tracking), '') = '' then raise exception 'tracking_required'; end if;
  elsif p_to = 'cancelled' then
    if o.status not in ('pending', 'paid', 'fulfilled') then raise exception 'invalid_transition: % -> cancelled', o.status; end if;
    if o.status <> 'pending' and coalesce(trim(p_note), '') = '' then raise exception 'note_required'; end if;
  else
    raise exception 'invalid_transition: % -> %', o.status, p_to;
  end if;

  -- cancelling an order that already took stock puts the items back (the refund itself is done in Stripe)
  if p_to = 'cancelled' and o.status in ('paid', 'fulfilled') then
    for i in select product_id, quantity from public.hardware_order_items where order_id = o.id and product_id is not null loop
      update public.hardware_products set stock_qty = stock_qty + i.quantity where id = i.product_id;
    end loop;
  end if;

  update public.hardware_orders set
    status = p_to,
    carrier = case when p_to = 'shipped' then left(nullif(trim(p_carrier), ''), 60) else carrier end,
    tracking_number = case when p_to = 'shipped' then left(trim(p_tracking), 120) else tracking_number end,
    shipped_at = case when p_to = 'shipped' then now() else shipped_at end,
    refund_note = case when p_to = 'cancelled' and coalesce(trim(p_note), '') <> ''
                       then left(coalesce(refund_note || E'\n', '') || 'Cancelled: ' || trim(p_note), 1000) else refund_note end
  where id = o.id;

  perform public.write_audit('hardware_order.' || p_to, 'hardware_orders', o.id::text,
    jsonb_build_object('status', o.status),
    jsonb_build_object('status', p_to, 'carrier', p_carrier, 'tracking', p_tracking, 'note', p_note), p_actor);
  return jsonb_build_object('order_number', o.order_number, 'email', o.email, 'is_test', o.is_test, 'from', o.status, 'to', p_to, 'id', o.id);
end;
$$;

create or replace function public.hw_admin_note(p_order uuid, p_note text, p_actor uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if coalesce(trim(p_note), '') = '' then raise exception 'note_required'; end if;
  update public.hardware_orders
     set refund_note = left(coalesce(refund_note || E'\n', '') || to_char(now(), 'YYYY-MM-DD') || ' ' || trim(p_note), 1000)
   where id = p_order;
  if not found then raise exception 'order_not_found'; end if;
  perform public.write_audit('hardware_order.note', 'hardware_orders', p_order::text, null, jsonb_build_object('note', trim(p_note)), p_actor);
end;
$$;

-- ---------------------------------------------------------------- owner invites
-- Non-consuming check used by the activation page before it creates the owner's login.
create or replace function public.onb_peek_invite(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare r public.owner_invites;
begin
  select * into r from public.owner_invites
   where token_hash = public.onb_hash(p_token) and consumed_at is null and expires_at > now();
  if r.id is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  return jsonb_build_object('tenant_id', r.tenant_id, 'email', r.email, 'full_name', r.full_name, 'application_id', r.application_id);
end;
$$;

-- New link for an owner who has not activated yet (lost email, expired link, or the welcome email failed).
create or replace function public.onb_reissue_invite(p_app uuid, p_actor uuid)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare r public.owner_invites; v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select * into r from public.owner_invites where application_id = p_app for update;
  if r.id is null then raise exception 'not_provisioned'; end if;
  if r.consumed_at is not null then raise exception 'already_activated'; end if;
  update public.owner_invites set token_hash = public.onb_hash(v_token), expires_at = now() + interval '14 days' where id = r.id;
  perform public.write_audit('invite.reissue', 'onboarding_applications', p_app::text, null, jsonb_build_object('email', r.email), p_actor);
  return jsonb_build_object('email', r.email, 'full_name', r.full_name, 'tenant_id', r.tenant_id, 'invite_token', v_token,
    'license_key', (select license_key from public.licenses where tenant_id = r.tenant_id and kind = 'business' limit 1));
end;
$$;

-- ---------------------------------------------------------------- config validation
-- The console edits prices, fees and tax. Reject values that would break checkout or overcharge.
create or replace function public.app_config_validate()
returns trigger
language plpgsql
as $$
declare m jsonb; k text; v jsonb;
begin
  v := new.value;
  if new.key = 'online_fee' then
    if v ->> 'type' not in ('percent', 'flat') then raise exception 'config_invalid: online_fee.type'; end if;
    if jsonb_typeof(v -> 'value') <> 'number' or (v ->> 'value')::numeric < 0 then raise exception 'config_invalid: online_fee.value'; end if;
    if v ->> 'type' = 'percent' and (v ->> 'value')::numeric > 100 then raise exception 'config_invalid: online_fee.percent_over_100'; end if;
  elsif new.key = 'hardware_tax' then
    if v ->> 'mode' not in ('flat', 'stripe_tax') then raise exception 'config_invalid: hardware_tax.mode'; end if;
    if jsonb_typeof(v -> 'rate_pct') <> 'number' or (v ->> 'rate_pct')::numeric < 0 or (v ->> 'rate_pct')::numeric > 30 then
      raise exception 'config_invalid: hardware_tax.rate_pct';
    end if;
  elsif new.key = 'hardware_shipping' then
    if jsonb_typeof(v -> 'methods') <> 'array' or jsonb_array_length(v -> 'methods') = 0 then raise exception 'config_invalid: hardware_shipping.methods'; end if;
    for m in select * from jsonb_array_elements(v -> 'methods') loop
      if coalesce(m ->> 'id', '') = '' or coalesce(m ->> 'name', '') = '' or jsonb_typeof(m -> 'cents') <> 'number'
         or (m ->> 'cents')::numeric < 0 or (m ->> 'cents')::numeric <> floor((m ->> 'cents')::numeric) then
        raise exception 'config_invalid: hardware_shipping.method';
      end if;
    end loop;
  elsif new.key = 'plans' then
    for k in select unnest(array['model_a', 'model_b']) loop
      if jsonb_typeof(v -> k -> 'monthly_cents') <> 'number' or (v -> k ->> 'monthly_cents')::numeric < 0 then raise exception 'config_invalid: plans.%.monthly_cents', k; end if;
      if jsonb_typeof(v -> k -> 'setup_cents') <> 'number' or (v -> k ->> 'setup_cents')::numeric < 0 then raise exception 'config_invalid: plans.%.setup_cents', k; end if;
    end loop;
  elsif new.key = 'addons' then
    for k in select key from jsonb_each(v) where key <> 'is_placeholder' loop
      if jsonb_typeof(v -> k -> 'monthly_cents') <> 'number' or (v -> k ->> 'monthly_cents')::numeric < 0 then raise exception 'config_invalid: addons.%.monthly_cents', k; end if;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_app_config_validate on public.app_config;
create trigger trg_app_config_validate before insert or update on public.app_config
  for each row execute function public.app_config_validate();

revoke all on function public.hw_admin_transition(uuid, text, text, text, text, uuid), public.hw_admin_note(uuid, text, uuid),
  public.onb_peek_invite(text), public.onb_reissue_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hw_admin_transition(uuid, text, text, text, text, uuid), public.hw_admin_note(uuid, text, uuid),
  public.onb_peek_invite(text), public.onb_reissue_invite(uuid, uuid) to service_role;

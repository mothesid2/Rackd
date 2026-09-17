








alter table public.locations add column if not exists stripe_account_id text;
alter table public.locations add column if not exists stripe_onboarding_complete boolean not null default false;


alter table public.online_orders add column if not exists online_fee numeric(12,2) not null default 0;


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
  c_fee_rate constant numeric := 0.05; 
begin
  if v_cust is null then raise exception 'not authenticated'; end if;

  select * into v_prof from public.storefront_customers where id = v_cust;
  if v_prof.id is null or v_prof.age_verified is not true
     or v_prof.age_verified_at is null
     or v_prof.age_verified_at < now() - make_interval(days => p_reverify_days) then
    raise exception 'age_verification_required';
  end if;

  
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


create or replace function public.set_storefront_settings(
  p_location uuid, p_enabled boolean, p_tax_rate numeric default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;

  
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





alter table public.online_orders add column if not exists receipt_printed_at timestamptz;







create table if not exists public.product_images (
  tenant_id  uuid not null,
  barcode    text not null,
  image_url  text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, barcode)
);
alter table public.product_images enable row level security;


drop policy if exists "pi_read" on public.product_images;
create policy "pi_read" on public.product_images for select to anon, authenticated using (true);


drop policy if exists "pi_insert_manager" on public.product_images;
create policy "pi_insert_manager" on public.product_images for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and public.is_manager());
drop policy if exists "pi_update_manager" on public.product_images;
create policy "pi_update_manager" on public.product_images for update to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_manager())
  with check (tenant_id = public.current_tenant_id() and public.is_manager());

drop trigger if exists trg_product_images_updated_at on public.product_images;
create trigger trg_product_images_updated_at before update on public.product_images
  for each row execute function public.set_updated_at();


insert into storage.buckets (id, name, public)
  values ('product-images', 'product-images', true)
  on conflict (id) do update set public = true;


drop policy if exists "product_images_public_read" on storage.objects;
create policy "product_images_public_read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images');

drop policy if exists "product_images_manager_write" on storage.objects;
create policy "product_images_manager_write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-images' and public.is_manager()
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
drop policy if exists "product_images_manager_update" on storage.objects;
create policy "product_images_manager_update" on storage.objects for update to authenticated
  using (
    bucket_id = 'product-images' and public.is_manager()
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );


drop function if exists public.storefront_menu(uuid);
create or replace function public.storefront_menu(p_location uuid)
returns table (barcode text, name text, category text, price numeric, available integer, stock_status text, image_url text)
language sql stable security definer set search_path = public as $$
  select sp.barcode,
         coalesce(inv.name, sp.barcode)                                   as name,
         inv.category,
         coalesce(sp.override_price, inv.price)                           as price,
         public.storefront_available(l.tenant_id, p_location, sp.barcode) as available,
         case
           when public.storefront_available(l.tenant_id, p_location, sp.barcode) <= 0 then 'out'
           when public.storefront_available(l.tenant_id, p_location, sp.barcode) <= 3 then 'low'
           else 'in'
         end                                                              as stock_status,
         pi.image_url                                                     as image_url
    from public.storefront_products sp
    join public.locations l on l.id = sp.location_id and l.is_storefront_enabled
    left join lateral (
      select name, category, price from public.inventory_cloud
       where tenant_id = l.tenant_id and location_id = p_location and barcode = sp.barcode
       order by updated_at desc limit 1
    ) inv on true
    left join public.product_images pi on pi.tenant_id = l.tenant_id and pi.barcode = sp.barcode
   where sp.location_id = p_location and sp.is_visible
     and coalesce(sp.override_price, inv.price) is not null
   order by inv.category nulls last, name;
$$;
grant execute on function public.storefront_menu(uuid) to anon, authenticated;






alter table public.employees_cloud add column if not exists must_change_password boolean not null default false;
alter table public.employees_cloud add column if not exists must_change_pin      boolean not null default false;


drop policy if exists "employees_cloud_select" on public.employees_cloud;
create policy "employees_cloud_select" on public.employees_cloud for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists "employees_cloud_insert" on public.employees_cloud;
create policy "employees_cloud_insert" on public.employees_cloud for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "employees_cloud_update" on public.employees_cloud;
create policy "employees_cloud_update" on public.employees_cloud for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());





alter table public.locations add column if not exists address   text;
alter table public.locations add column if not exists zip       text;   
alter table public.locations add column if not exists logo_url  text;
alter table public.locations add column if not exists show_logo boolean not null default false;


create or replace function public.set_storefront_branding(
  p_location uuid, p_address text default null, p_logo_url text default null,
  p_show_logo boolean default null, p_zip text default null
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  if not public.is_manager() then raise exception 'manager_required'; end if;
  update public.locations
     set address   = coalesce(p_address, address),
         zip       = coalesce(p_zip, zip),
         logo_url  = coalesce(p_logo_url, logo_url),
         show_logo = coalesce(p_show_logo, show_logo)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_branding(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.set_storefront_branding(uuid, text, text, boolean, text) to authenticated;





alter table public.online_orders add column if not exists customer_name  text;
alter table public.online_orders add column if not exists customer_phone text;

create or replace function public.fill_online_order_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_name is null or new.customer_phone is null then
    select
      coalesce(new.customer_name, nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')),
      coalesce(new.customer_phone, c.phone)
      into new.customer_name, new.customer_phone
      from public.storefront_customers c
     where c.id = new.customer_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_fill_online_order_customer on public.online_orders;
create trigger trg_fill_online_order_customer
  before insert on public.online_orders
  for each row execute function public.fill_online_order_customer();


update public.online_orders o
   set customer_name  = nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
       customer_phone = c.phone
  from public.storefront_customers c
 where c.id = o.customer_id
   and (o.customer_name is null or o.customer_phone is null);







create or replace function public.store_sales_by_location(p_start timestamptz, p_end timestamptz)
returns table (tenant_id uuid, location_id uuid, revenue numeric, txn_count bigint, refund_count bigint)
language sql stable security definer set search_path = public as $$
  select tenant_id, location_id,
         coalesce(sum(total), 0)             as revenue,
         count(*)                            as txn_count,
         count(*) filter (where total < 0)   as refund_count
    from public.transactions_cloud
   where created_at >= p_start and created_at < p_end
   group by tenant_id, location_id;
$$;
grant execute on function public.store_sales_by_location(timestamptz, timestamptz) to service_role;


create table if not exists public.owner_audit_log (
  id           bigint generated always as identity primary key,
  tenant_id    uuid,
  actor        text not null default 'owner_console',
  action       text not null,               
  target_uid   uuid,                         
  target_label text,                         
  detail       jsonb not null default '{}',  
  created_at   timestamptz not null default now()
);
create index if not exists idx_owner_audit_tenant on public.owner_audit_log (tenant_id, created_at desc);
alter table public.owner_audit_log enable row level security;






alter table public.storefront_customers add column if not exists sms_consent_transactional boolean not null default false;
alter table public.storefront_customers add column if not exists sms_consent_marketing    boolean not null default false;
alter table public.storefront_customers add column if not exists sms_consent_at            timestamptz;


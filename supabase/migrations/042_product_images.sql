-- 042_product_images.sql
-- Product photos (spec item 11). Business-wide by barcode: one image per product
-- identity, shared across all of a business's locations. Managers upload from the
-- portal; the storefront shows them on product cards.

-- ── image registry (tenant + barcode -> public URL) ─────────────────────────
create table if not exists public.product_images (
  tenant_id  uuid not null,
  barcode    text not null,
  image_url  text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, barcode)
);
alter table public.product_images enable row level security;

-- Read is public (product photos are non-sensitive; the storefront is public).
drop policy if exists "pi_read" on public.product_images;
create policy "pi_read" on public.product_images for select to anon, authenticated using (true);

-- Only a manager of the owning tenant may set/replace an image.
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

-- ── storage bucket (public read, manager write) ─────────────────────────────
insert into storage.buckets (id, name, public)
  values ('product-images', 'product-images', true)
  on conflict (id) do update set public = true;

-- Path convention: <tenant_id>/<barcode>.<ext> so writes scope by the first folder.
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

-- ── storefront_menu gains image_url ──────────────────────────────────────────
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

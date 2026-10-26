-- 097: bulk item operations used by the Storefront Manager (atomic, permission-checked, tenant-scoped).
-- Reverse with supabase/down/097_down.sql.

create or replace function public.sf_bulk_set_status(p_ids uuid[], p_status text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.sf_can('storefront.items.edit') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('available', 'sold_out', 'hidden') then raise exception 'status_invalid'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 1000 then raise exception 'too_many_items'; end if;
  update public.storefront_items set status = p_status where id = any (p_ids) and tenant_id = public.current_tenant_id() and status <> p_status;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- p_ids is the full desired order for the location; unknown ids are ignored, items not listed keep their place after.
create or replace function public.sf_reorder_items(p_location uuid, p_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sf_can('storefront.items.edit') then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.sf_location_tenant(p_location) is distinct from public.current_tenant_id() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.storefront_items i set sort_order = o.ord * 10
    from (select id, ordinality as ord from unnest(p_ids) with ordinality as t(id, ordinality)) o
   where i.id = o.id and i.location_id = p_location and i.tenant_id = public.current_tenant_id();
end;
$$;

create or replace function public.sf_duplicate_item(p_item uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare it public.storefront_items; v_id uuid;
begin
  if not public.sf_can('storefront.items.edit') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into it from public.storefront_items where id = p_item and tenant_id = public.current_tenant_id();
  if it.id is null then raise exception 'item_not_found'; end if;
  if it.source <> 'curated' then raise exception 'pos_items_cannot_be_duplicated'; end if;
  insert into public.storefront_items (tenant_id, location_id, source, name, brand, flavor, size, price, image_url, category, status, qty, sort_order)
  values (it.tenant_id, it.location_id, 'curated', left(it.name, 112) || ' (copy)', it.brand, it.flavor, it.size, it.price, it.image_url, it.category, 'hidden', it.qty, it.sort_order + 1)
  returning id into v_id;
  return v_id;
end;
$$;

-- CSV import rows: [{name, brand, flavor, size, price, qty}]. Valid rows are inserted; invalid ones are reported by row number.
create or replace function public.sf_import_items(p_location uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; i integer := 0; ok integer := 0; errs jsonb := '[]'::jsonb; v_price numeric; v_qty integer; v_name text; v_next integer;
begin
  if not public.sf_can('storefront.items.edit') then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.sf_location_tenant(p_location) is distinct from public.current_tenant_id() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.storefront_settings where location_id = p_location and inventory_mode = 'curated') then raise exception 'import_needs_curated_mode'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'too_many_rows'; end if;
  select coalesce(max(sort_order), 0) + 10 into v_next from public.storefront_items where location_id = p_location;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_name := nullif(trim(r ->> 'name'), '');
      if v_name is null then raise exception 'name is required'; end if;
      if char_length(v_name) > 120 then raise exception 'name is longer than 120 characters'; end if;
      begin v_price := (r ->> 'price')::numeric; exception when others then raise exception 'price is not a number'; end;
      if v_price is null or v_price < 0 or v_price >= 100000 then raise exception 'price must be between 0 and 99999.99'; end if;
      begin v_qty := nullif(r ->> 'qty', '')::integer; exception when others then raise exception 'qty is not a whole number'; end;
      if v_qty is not null and v_qty < 0 then raise exception 'qty cannot be negative'; end if;
      insert into public.storefront_items (tenant_id, location_id, source, name, brand, flavor, size, price, qty, category, status, sort_order)
      values (public.current_tenant_id(), p_location, 'curated', v_name, left(nullif(trim(r ->> 'brand'), ''), 80), left(nullif(trim(r ->> 'flavor'), ''), 80),
              left(nullif(trim(r ->> 'size'), ''), 40), round(v_price, 2), v_qty, left(nullif(trim(r ->> 'category'), ''), 60), 'available', v_next);
      v_next := v_next + 10; ok := ok + 1;
    exception when others then
      errs := errs || jsonb_build_array(jsonb_build_object('row', i, 'message', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('inserted', ok, 'errors', errs);
end;
$$;

revoke all on function public.sf_bulk_set_status(uuid[], text), public.sf_reorder_items(uuid, uuid[]), public.sf_duplicate_item(uuid), public.sf_import_items(uuid, jsonb) from public, anon;
grant execute on function public.sf_bulk_set_status(uuid[], text), public.sf_reorder_items(uuid, uuid[]), public.sf_duplicate_item(uuid), public.sf_import_items(uuid, jsonb) to authenticated;

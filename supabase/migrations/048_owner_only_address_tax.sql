



create table if not exists public.zip3_tax_rates (
  zip3     text primary key,
  rate     numeric(6,4) not null
);
alter table public.zip3_tax_rates enable row level security;


create or replace function public.tax_rate_for_zip(p_zip text, p_default numeric default 0.0825)
returns numeric language sql stable set search_path = public as $$
  select coalesce(
    (select rate from public.zip3_tax_rates where zip3 = left(regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g'), 3)),
    p_default
  );
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
     set is_storefront_enabled = coalesce(p_enabled, is_storefront_enabled)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;

  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_settings(uuid, boolean, numeric) from public, anon;
grant execute on function public.set_storefront_settings(uuid, boolean, numeric) to authenticated;


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
     set logo_url  = coalesce(p_logo_url, logo_url),
         show_logo = coalesce(p_show_logo, show_logo)
   where id = p_location and tenant_id = public.current_tenant_id()
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_storefront_branding(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.set_storefront_branding(uuid, text, text, boolean, text) to authenticated;


create or replace function public.set_location_address(
  p_location uuid, p_address text, p_zip text
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  update public.locations
     set address   = coalesce(p_address, address),
         zip       = coalesce(p_zip, zip),
         tax_rate  = public.tax_rate_for_zip(coalesce(p_zip, zip), tax_rate)
   where id = p_location
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_location_address(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_location_address(uuid, text, text) to service_role;


insert into public.zip3_tax_rates (zip3, rate) values
  ('000', 0.0625), 
  ('750', 0.0825), ('751', 0.0825), ('752', 0.0825), ('753', 0.0825), ('754', 0.0825), 
  ('770', 0.0825), ('772', 0.0825), ('773', 0.0825), ('774', 0.0825), ('775', 0.0825), 
  ('787', 0.0825), ('786', 0.0825),                                                    
  ('900', 0.0950), ('901', 0.0950), ('902', 0.0950), ('906', 0.0950),                   
  ('941', 0.0863), ('944', 0.0863),                                                     
  ('100', 0.0888), ('101', 0.0888), ('102', 0.0888),                                    
  ('600', 0.1025), ('606', 0.1025),                                                     
  ('850', 0.0860), ('852', 0.0860),                                                     
  ('300', 0.0790), ('303', 0.0790),                                                     
  ('331', 0.0700), ('332', 0.0700), ('334', 0.0700),                                     
  ('980', 0.1025), ('981', 0.1025)                                                       
on conflict (zip3) do nothing;

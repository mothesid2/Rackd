-- 049_owner_console_full_control.sql
--
-- Items 16 & 17 (UI/UX batch): the Owner Console's per-business view needs to
-- cover contact info at both the store level and the owner/business level. That
-- data doesn't exist yet — everything else the owner needs (ads via
-- licenses.display_config, features via licenses.features, kiosks, permissions,
-- passwords, address+tax via 048's set_location_address) is already modeled.

-- ── store-level contact (per location) ───────────────────────────────────────
alter table public.locations add column if not exists phone text;
alter table public.locations add column if not exists email text;

-- ── owner/business-level contact (on the business's own license row) ────────
alter table public.licenses add column if not exists contact_email text;
alter table public.licenses add column if not exists contact_phone text;

-- ── owner-only setter for store-level contact (service role / admin fn) ─────
create or replace function public.set_location_contact(
  p_location uuid, p_phone text, p_email text
)
returns public.locations
language plpgsql security definer set search_path = public as $$
declare v_row public.locations%rowtype;
begin
  update public.locations
     set phone = coalesce(p_phone, phone),
         email = coalesce(p_email, email)
   where id = p_location
  returning * into v_row;
  if v_row.id is null then raise exception 'location_not_found'; end if;
  return v_row;
end;
$$;
revoke all on function public.set_location_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_location_contact(uuid, text, text) to service_role;

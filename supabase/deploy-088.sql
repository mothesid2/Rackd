-- 088: register an agreement version (idempotent). The server hashes the exact text shown to the
-- applicant and calls this; the returned id is what gets signed. Reverse with supabase/down/088_down.sql.

create or replace function public.onb_ensure_agreement(p_kind text, p_version text, p_sha256 text, p_url text default null)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare v_id uuid; v_sha text;
begin
  insert into public.agreement_versions (kind, version, body_sha256, body_url)
  values (p_kind, p_version, p_sha256, p_url)
  on conflict (kind, version) do nothing;
  select id, body_sha256 into v_id, v_sha from public.agreement_versions where kind = p_kind and version = p_version;
  -- a published version is immutable: changed text must ship under a new version string
  if v_sha <> p_sha256 then raise exception 'agreement_text_changed_without_new_version'; end if;
  return v_id;
end;
$$;
revoke all on function public.onb_ensure_agreement(text, text, text, text) from public, anon, authenticated;
grant execute on function public.onb_ensure_agreement(text, text, text, text) to service_role;

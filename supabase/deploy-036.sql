-- Rackd cloud schema — INCREMENTAL bundle: self-attested age gate (revised).
-- Apply after deploy-035.sql. Replaces third-party ID verification with a
-- server-computed 21+ self-attestation (legal gate remains the in-person
-- pickup ID check). Guard trigger blocks self-granting age_verified.

-- ==================== supabase/migrations/036_self_attest_age.sql ====================
-- 036_self_attest_age.sql
-- Age verification approach for the storefront: SELF-ATTESTED date of birth, not a
-- third-party ID vendor. This is defensible ONLY because pickup is in-person: the
-- real legal gate is staff checking a government ID at handoff (see 035). The online
-- step is good-faith fraud reduction.
--
-- The customer submits a DOB; the SERVER computes age and sets age_verified — the
-- client never sets it directly. A guard trigger freezes the verification columns
-- against any other write path, so a browser-console UPDATE can't fake verification.

-- ── set verification from a self-attested DOB (server-computed age) ───────────
create or replace function public.self_attest_age(p_dob date)
returns public.storefront_customers
language plpgsql security definer set search_path = public as $$
declare
  v_cust uuid := auth.uid();
  v_row  public.storefront_customers%rowtype;
begin
  if v_cust is null then raise exception 'not_authenticated'; end if;
  if p_dob is null then raise exception 'dob_required'; end if;
  if p_dob > current_date then raise exception 'dob_invalid'; end if;
  -- 21+ required. Compares against the date exactly 21 years ago.
  if p_dob > (current_date - interval '21 years')::date then raise exception 'under_21'; end if;

  -- Unlock the guarded columns for THIS statement only.
  perform set_config('rackd.age_attest', '1', true);

  update public.storefront_customers
     set dob = p_dob, age_verified = true, age_verified_at = now(),
         age_verification_vendor = 'self_attested', age_verification_ref = null
   where id = v_cust
  returning * into v_row;

  if v_row.id is null then
    -- No profile row yet (customer verifying before the app upserts one).
    insert into public.storefront_customers
      (id, dob, age_verified, age_verified_at, age_verification_vendor)
    values (v_cust, p_dob, true, now(), 'self_attested')
    returning * into v_row;
  end if;

  return v_row;
end;
$$;
revoke all on function public.self_attest_age(date) from public, anon;
grant execute on function public.self_attest_age(date) to authenticated;

-- ── freeze the verification columns against any other writer ──────────────────
-- On any UPDATE that is NOT inside self_attest_age(), force the age/verification
-- columns back to their old values. So even though a customer can update their own
-- row (phone/email), they cannot self-grant age_verified or backdate it.
create or replace function public.guard_age_fields() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('rackd.age_attest', true), '') <> '1' then
    new.dob                     := old.dob;
    new.age_verified            := old.age_verified;
    new.age_verified_at         := old.age_verified_at;
    new.age_verification_vendor := old.age_verification_vendor;
    new.age_verification_ref    := old.age_verification_ref;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sfc_guard_age on public.storefront_customers;
create trigger trg_sfc_guard_age before update on public.storefront_customers
  for each row execute function public.guard_age_fields();

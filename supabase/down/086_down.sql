drop function if exists public.permit_notice_mark(uuid, integer, date);
drop function if exists public.permits_due_for_notice();
drop function if exists public.onb_redeem_invite(text);
drop function if exists public.onb_mark_activated(uuid);
drop function if exists public.onb_provision(uuid, uuid);
drop function if exists public.onb_gen_license_key();
drop table if exists public.permit_notices;
drop table if exists public.business_permits;
drop table if exists public.business_fee_settings;
drop table if exists public.owner_invites;
drop table if exists public.provision_runs;
-- licenses.plan_type, locations.city/state are left in place (additive columns, harmless).

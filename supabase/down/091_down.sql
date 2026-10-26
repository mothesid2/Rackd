drop trigger if exists trg_app_config_validate on public.app_config;
drop function if exists public.app_config_validate();
drop function if exists public.onb_reissue_invite(uuid, uuid);
drop function if exists public.onb_peek_invite(text);
drop function if exists public.hw_admin_note(uuid, text, uuid);
drop function if exists public.hw_admin_transition(uuid, text, text, text, text, uuid);
drop function if exists public.admin_whoami();

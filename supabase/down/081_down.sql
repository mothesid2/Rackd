drop function if exists public.rate_limit_hit(text, integer, integer);
drop table if exists public.rate_limits;
drop table if exists public.app_config;
drop function if exists public.app_config_stamp();
drop function if exists public.audit_row_change();
drop function if exists public.write_audit(text, text, text, jsonb, jsonb, uuid);
drop table if exists public.audit_log;
drop function if exists public.is_platform_admin();
drop table if exists public.platform_admins;

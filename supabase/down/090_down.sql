drop function if exists public.hw_mark_refunded(text, boolean, text);
drop function if exists public.hw_mark_paid(uuid, text, text, integer, integer, boolean);
drop function if exists public.hw_event_done(text);
drop function if exists public.hw_event_begin(text, text);
drop function if exists public.hw_issue_email_token(uuid, text);
drop function if exists public.hw_set_session(uuid, text);
-- restore the 089 version of hw_get_order (browser token only) by re-running supabase/migrations/089_hardware_orders_rpc.sql
-- hardware_orders.email_token_hash is left in place (additive column).

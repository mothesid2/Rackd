drop function if exists public.hw_get_order(uuid, text);
drop function if exists public.hw_create_order(text, uuid, uuid, jsonb, text, integer, integer, integer, integer, integer, text, boolean, text, jsonb);
drop function if exists public.hw_order_tenant();
-- hardware_orders.discount_cents is left in place (additive column).

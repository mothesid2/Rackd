drop policy if exists product_images_owner_write on storage.objects;
drop function if exists public.sf_staff_list();
drop function if exists public.sf_pos_products(uuid, text, integer);
drop function if exists public.sf_items_list(uuid);
drop function if exists public.sf_my_permissions();

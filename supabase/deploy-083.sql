-- 083: private bucket for onboarding documents (licenses, owner IDs).
-- No storage.objects policies are created for this bucket, so every client role is denied;
-- the server uses the service role to issue short-lived signed upload/read URLs only.
-- Reverse with supabase/down/083_down.sql.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onboarding-docs', 'onboarding-docs', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'];

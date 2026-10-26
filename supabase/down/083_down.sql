-- Objects must be removed via the Storage API before a bucket can be deleted.
delete from storage.buckets where id = 'onboarding-docs' and not exists (
  select 1 from storage.objects where bucket_id = 'onboarding-docs');

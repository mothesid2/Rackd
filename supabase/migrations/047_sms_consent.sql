

alter table public.storefront_customers add column if not exists sms_consent_transactional boolean not null default false;
alter table public.storefront_customers add column if not exists sms_consent_marketing    boolean not null default false;
alter table public.storefront_customers add column if not exists sms_consent_at            timestamptz;

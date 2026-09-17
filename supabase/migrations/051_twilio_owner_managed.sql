


alter table public.licenses add column if not exists twilio_account_sid text;
alter table public.licenses add column if not exists twilio_auth_token text;
alter table public.licenses add column if not exists twilio_from_number text;

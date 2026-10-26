-- Minimal Supabase-like environment so the onboarding migrations and RLS tests can run against a
-- plain/embedded Postgres (scripts/run-sql-tests.js). NOT deployed to Supabase, which provides all of this.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;

create extension if not exists pgcrypto with schema extensions;

grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create table if not exists auth.users (id uuid primary key, email text);

create or replace function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
$$ select auth.jwt() ->> 'role' $$;

create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant select on storage.buckets, storage.objects to anon, authenticated, service_role;

-- tables the real migrations 001/012/015/031/044/049 create; only the columns 081-086 touch
create or replace function public.current_tenant_id() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'tenant_id', '')::uuid $$;

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  license_key text unique not null,
  tenant_id uuid not null,
  active boolean not null default true,
  tier text check (tier in ('core','standard','pro','enterprise')),
  features text[] not null default '{}',
  max_registers integer not null default 1,
  location_count integer not null default 1,
  name text,
  kind text not null default 'register'
);
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null default 'Store',
  is_storefront_enabled boolean not null default false,
  address text, zip text, phone text
);

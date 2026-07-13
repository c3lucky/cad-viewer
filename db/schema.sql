create extension if not exists pgcrypto;

create table if not exists viewer_links (
  id uuid primary key default gen_random_uuid(),
  public_model_id text,
  query_hash text not null unique,
  project_number text not null,
  model_name text not null,
  model_file_name text not null,
  storage_path text not null,
  hubspot_access_key text,
  hubspot_access_secret_hash text,
  hubspot_access_secret_last4 text,
  hubspot_access_generated_at timestamptz,
  hubspot_access_rotated_at timestamptz,
  hubspot_object_id text,
  hubspot_published_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table viewer_links
  add column if not exists public_model_id text,
  add column if not exists hubspot_access_key text,
  add column if not exists hubspot_access_secret_hash text,
  add column if not exists hubspot_access_secret_last4 text,
  add column if not exists hubspot_access_generated_at timestamptz,
  add column if not exists hubspot_access_rotated_at timestamptz,
  add column if not exists hubspot_object_id text,
  add column if not exists hubspot_published_at timestamptz;

create index if not exists viewer_links_project_number_idx
  on viewer_links (project_number);

create unique index if not exists viewer_links_public_model_id_idx
  on viewer_links (public_model_id)
  where public_model_id is not null;

create index if not exists viewer_links_active_hash_idx
  on viewer_links (query_hash)
  where is_active = true;

create unique index if not exists viewer_links_hubspot_access_key_idx
  on viewer_links (hubspot_access_key)
  where hubspot_access_key is not null;

create table if not exists hubspot_project_access (
  id uuid primary key default gen_random_uuid(),
  project_number text not null,
  access_key text not null,
  hubspot_object_id text,
  object_type_id text,
  serial_number_name text,
  mapped_model_id text,
  query_hash text,
  model_file_name text,
  viewer_url text,
  has_mapped_model boolean not null default false,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_webhook_event_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table hubspot_project_access
  add column if not exists mapped_model_id text,
  add column if not exists viewer_url text,
  add column if not exists is_active boolean not null default true;

create unique index if not exists hubspot_project_access_access_key_idx
  on hubspot_project_access (access_key)
  where is_active = true;

create unique index if not exists hubspot_project_access_object_id_idx
  on hubspot_project_access (hubspot_object_id)
  where hubspot_object_id is not null and is_active = true;

create index if not exists hubspot_project_access_project_number_idx
  on hubspot_project_access (project_number)
  where is_active = true;

create index if not exists hubspot_project_access_query_hash_idx
  on hubspot_project_access (query_hash)
  where query_hash is not null and is_active = true;

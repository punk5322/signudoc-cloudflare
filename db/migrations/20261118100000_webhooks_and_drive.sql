-- Webhooks and Google Drive filing, both set up by an administrator in
-- Settings.
--
-- * webhook_endpoints: where to POST envelope events, and which ones. The
--   signing secret is stored encrypted with a key derived from the auth
--   secret, and shown to the administrator once, when the endpoint is added.
-- * google_drive_connection: at most one row. The Google refresh token is
--   stored encrypted the same way.
-- * integration_deliveries: the queue. A row is added in the same
--   transaction as the envelope's audit event, so an event that is
--   committed is never lost and one rolled back is never sent. Failed
--   attempts are retried later with a growing delay.

create table if not exists public.webhook_endpoints (
  id text primary key,
  url text not null,
  events text[] not null,
  secret_encrypted text not null,
  created_by text,
  created_at bigint not null
);

create table if not exists public.google_drive_connection (
  id integer primary key default 1 check (id = 1),
  refresh_token_encrypted text not null,
  account_email text,
  folder_id text not null,
  folder_name text,
  subfolder_per_envelope boolean not null default false,
  connected_by text,
  connected_at bigint not null,
  last_upload_at bigint,
  last_upload_error text
);

create table if not exists public.integration_deliveries (
  id text primary key,
  target text not null check (target in ('webhook', 'drive')),
  endpoint_id text references public.webhook_endpoints(id) on delete cascade,
  event text not null,
  envelope_id text,
  audit_event_id text,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at bigint not null,
  last_attempt_at bigint,
  last_status_code integer,
  last_error text,
  created_at bigint not null,
  check ((target = 'webhook') = (endpoint_id is not null))
);

create index if not exists idx_integration_deliveries_due
  on public.integration_deliveries (next_attempt_at)
  where status = 'pending';

create index if not exists idx_integration_deliveries_endpoint
  on public.integration_deliveries (endpoint_id, created_at desc);

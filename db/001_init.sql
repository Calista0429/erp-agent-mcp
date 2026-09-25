-- Agent execution runtime for a headless ERP.
--
-- Design notes
--  * Business models are NOT tables. They are defined as code in tenants/<ws>/models/*.ts
--    (schema-as-code), reviewed in git and editable by a coding agent. Postgres only stores
--    records (JSONB) plus the runtime's own control tables.
--  * Tenant isolation is enforced by Postgres RLS, not by application WHERE clauses.
--    The app connects as `erp_app` (not owner, not superuser) and sets `app.workspace_id`
--    per transaction. A forgotten filter in app code cannot leak another tenant's rows.
--  * Agents never write records directly. Every write becomes a pending_action (a plan /
--    dry-run diff) that a *human* principal must approve before the executor applies it.

create extension if not exists pgcrypto;

do $$ begin
  if not exists (select from pg_roles where rolname = 'erp_app') then
    create role erp_app login; -- password is set by `npm run setup` from ERP_APP_PASSWORD
  end if;
end $$;

-- current tenant, set with set_config('app.workspace_id', ..., true) inside each transaction
create or replace function app_workspace() returns text
  language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '') $$;

------------------------------------------------------------------------------------------
-- Tenancy & identity
------------------------------------------------------------------------------------------
create table workspaces (
  id          text primary key,                 -- 'acme', 'globex'
  name        text not null,
  created_at  timestamptz not null default now()
);

create table principals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  text not null references workspaces(id),
  name          text not null,
  kind          text not null check (kind in ('human', 'agent')),
  role          text not null,                  -- roles are interpreted by the schema (admin/sales/viewer...)
  token_hash    text not null unique,           -- sha256(token); raw tokens are never stored
  created_at    timestamptz not null default now()
);

-- Token lookup has to happen before we know the tenant, so it cannot go through RLS.
-- A SECURITY DEFINER function returns exactly one principal for a token hash; erp_app
-- has no SELECT on principals and therefore cannot enumerate other tenants' users.
create or replace function resolve_principal(p_token_hash text)
  returns table (id uuid, workspace_id text, name text, kind text, role text)
  language sql stable security definer set search_path = public as $$
    select id, workspace_id, name, kind, role from principals where token_hash = p_token_hash
  $$;
revoke all on function resolve_principal(text) from public;

-- Names of principals in the *current* tenant only (for audit/approval views).
create or replace function workspace_principals()
  returns table (id uuid, name text, kind text, role text)
  language sql stable security definer set search_path = public as $$
    select id, name, kind, role from principals where workspace_id = app_workspace()
  $$;
revoke all on function workspace_principals() from public;

------------------------------------------------------------------------------------------
-- Business data (all models, all tenants) — EAV-free "document per record"
------------------------------------------------------------------------------------------
create table records (
  workspace_id  text not null references workspaces(id),
  model         text not null,                  -- model name from schema-as-code, e.g. 'order_line'
  id            uuid not null default gen_random_uuid(),
  data          jsonb not null,
  version       integer not null default 1,     -- optimistic concurrency for approved plans
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, model, id)
);
create index records_data_gin on records using gin (data jsonb_path_ops);
-- Trade-off: range filters on casted JSONB values (e.g. order_date >= ...) cannot use the
-- GIN index. A production version would generate expression indexes from `.index()` hints
-- in the schema, or promote hot models to real tables.

------------------------------------------------------------------------------------------
-- Agent write path: plan -> human approval -> apply
------------------------------------------------------------------------------------------
create table pending_actions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     text not null references workspaces(id),
  requested_by     uuid not null references principals(id),
  tool             text not null,               -- e.g. 'place_order', 'product_update'
  args             jsonb not null,
  plan             jsonb not null,              -- { ops: [...], warnings: [...], errors: [...] }
  schema_hash      text not null,               -- schema version the plan was computed against
  idempotency_key  text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'blocked', 'approved', 'rejected', 'applied', 'failed', 'expired')),
  decided_by       uuid references principals(id),
  decided_at       timestamptz,
  applied_at       timestamptz,
  result           jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '15 minutes',
  -- an agent retrying the same call gets the same plan back instead of a duplicate order
  unique (workspace_id, requested_by, idempotency_key)
);

------------------------------------------------------------------------------------------
-- Audit: every tool call, allowed or denied. Append-only for the app role.
------------------------------------------------------------------------------------------
create table audit_log (
  id             bigint generated always as identity primary key,
  workspace_id   text not null references workspaces(id),
  principal_id   uuid not null references principals(id),
  tool           text not null,
  args           jsonb not null,
  outcome        text not null check (outcome in ('ok', 'denied', 'error', 'planned', 'approved', 'rejected', 'applied')),
  detail         jsonb,                          -- rows returned, action id, error message...
  schema_hash    text,
  duration_ms    integer,
  created_at     timestamptz not null default now()
);

------------------------------------------------------------------------------------------
-- Row-level security
------------------------------------------------------------------------------------------
alter table records         enable row level security;
alter table pending_actions enable row level security;
alter table audit_log       enable row level security;
alter table records         force row level security;
alter table pending_actions force row level security;
alter table audit_log       force row level security;

create policy tenant_isolation on records
  using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
create policy tenant_isolation on pending_actions
  using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
create policy tenant_isolation on audit_log
  using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());

grant usage on schema public to erp_app;
grant select on workspaces to erp_app;
grant select, insert, update on records to erp_app;          -- no DELETE: agents cannot hard-delete
grant select, insert, update on pending_actions to erp_app;
grant select, insert on audit_log to erp_app;                 -- append-only
grant execute on function resolve_principal(text) to erp_app;
grant execute on function workspace_principals() to erp_app;
grant execute on function app_workspace() to erp_app;

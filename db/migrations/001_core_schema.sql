-- 001 Core schema.
--
-- Conventions that hold throughout:
--   * Identifiers are opaque UUIDs, never sequential integers (SEC-011). An
--     attacker who guesses one still fails object-level authorisation, but
--     non-enumerable IDs remove the reconnaissance step entirely.
--   * Money is numeric(18,4). There is no float column in this schema (NFR-002).
--   * Amounts are addressable by (line, fiscal_year, period, budget_version) so
--     that adding scenarios later is a data migration, not a rewrite (FR-080).
--   * Every free-text column has a length bound, matching the boundary schema.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table users (
  id                uuid primary key default gen_random_uuid(),
  -- Entra ID object identifier. The only join to the identity provider.
  entra_oid         text unique,
  -- Stored lower-cased; uniqueness is enforced case-insensitively so two
  -- accounts cannot differ only by case and be treated as distinct principals.
  email             text not null check (email = lower(email) and length(email) <= 320),
  display_name      text not null check (length(display_name) <= 200),
  role              text not null check (role in (
                      'admin','cfo','finance_manager','cio','cto',
                      'infra_manager','security_manager','arch_manager','pmo')),
  is_active         boolean not null default true,
  -- CMP-133: erasure pseudonymises the actor and keeps the audit chain intact.
  pseudonymised_at  timestamptz,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  unique (email)
);

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------

create table entities (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Za-z0-9 _-]{1,32}$'),
  name        text not null check (length(name) <= 200),
  currency    text not null check (currency ~ '^[A-Z]{3}$'),
  deadline    date,
  state       text not null default 'draft'
              check (state in ('draft','submitted','changes_requested','approved','locked')),
  -- SPEC §9.4. Determines which regional deployment may hold the row; the
  -- application refuses to serve a row whose residency does not match its
  -- configured region, so a misrouted replica fails closed (CMP-140).
  residency   text not null default 'eu' check (residency in ('eu','ch','apac','cn')),
  created_at  timestamptz not null default now()
);

-- A manager may own more than one entity; scope is derived from this table
-- server-side on every request, never from the client (SEC-011).
create table entity_owners (
  entity_id  uuid not null references entities(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  primary key (entity_id, user_id)
);

create table categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) <= 120),
  cost_type  text not null check (cost_type in ('opex','capex')),
  position   integer not null,
  unique (name)
);

create table cost_centres (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  description     text not null check (length(description) <= 300),
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected')),
  created_by      uuid not null references users(id),
  approved_by     uuid references users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  -- SEC-012 segregation of duties, enforced in data rather than in the UI:
  -- the actor who creates a cost centre can never be the actor who approves it.
  constraint cost_centre_sod check (approved_by is null or approved_by <> created_by)
);

-- ---------------------------------------------------------------------------
-- Budget lines
-- ---------------------------------------------------------------------------

create table line_items (
  id                   uuid primary key default gen_random_uuid(),
  entity_id            uuid not null references entities(id) on delete cascade,
  category_id          uuid not null references categories(id),
  name                 text not null check (length(name) <= 200),
  vendor               text check (length(vendor) <= 200),
  cost_centre_id       uuid references cost_centres(id),
  gl_account           text check (gl_account ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  cost_type            text not null check (cost_type in ('opex','capex')),
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  justification        text check (length(justification) <= 4000),
  -- INV-3: when driver_key is set the amount is computed, never stored
  -- independently. The pair is all-or-nothing.
  driver_key           text check (driver_key in ('headcount','sites','devices','stores')),
  driver_rate_per_unit numeric(18,4),
  -- FR-030/FR-031
  asset_life_years     integer check (asset_life_years between 1 and 40),
  asset_life_status    text check (asset_life_status in ('pending','approved','rejected')),
  asset_life_decided_by uuid references users(id),
  -- NFR-005 optimistic concurrency.
  version              integer not null default 0,
  created_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint driver_link_complete check (
    (driver_key is null and driver_rate_per_unit is null) or
    (driver_key is not null and driver_rate_per_unit is not null)
  ),
  constraint capex_has_asset_life check (
    cost_type <> 'capex' or asset_life_years is not null or deleted_at is not null
  )
);

create index line_items_entity_idx on line_items (entity_id) where deleted_at is null;
create index line_items_category_idx on line_items (category_id) where deleted_at is null;

-- FR-080: the version dimension exists from day one. v1 only writes 'working'.
create table period_amounts (
  line_id        uuid not null references line_items(id) on delete cascade,
  fiscal_year    integer not null check (fiscal_year between 2000 and 2100),
  period         integer not null check (period between 1 and 12),
  budget_version text not null default 'working' check (length(budget_version) <= 32),
  -- Always in the line's own local currency. FX is applied at read time so a
  -- restated rate restates every derived figure consistently (NFR-003).
  amount         numeric(18,4) not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (line_id, fiscal_year, period, budget_version)
);

create table actuals (
  line_id      uuid not null references line_items(id) on delete cascade,
  fiscal_year  integer not null check (fiscal_year between 2000 and 2100),
  period       integer not null check (period between 1 and 12),
  amount       numeric(18,4) not null default 0,
  recorded_by  uuid not null references users(id),
  recorded_at  timestamptz not null default now(),
  -- FR-040: rows sourced from the ledger are not hand-editable.
  source       text not null default 'manual' check (source in ('manual','ledger')),
  primary key (line_id, fiscal_year, period)
);

create table line_comments (
  id          uuid primary key default gen_random_uuid(),
  line_id     uuid not null references line_items(id) on delete cascade,
  author_id   uuid not null references users(id),
  body        text not null check (length(body) <= 4000),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- FX, drivers, allocations
-- ---------------------------------------------------------------------------

create table fx_rates (
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  fiscal_year  integer not null check (fiscal_year between 2000 and 2100),
  -- EUR per one unit of `currency`, locked for the fiscal year (NFR-003).
  rate         numeric(18,8) not null check (rate > 0),
  updated_by   uuid references users(id),
  updated_at   timestamptz not null default now(),
  primary key (currency, fiscal_year)
);

create table drivers (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entities(id) on delete cascade,
  driver_key   text not null check (driver_key in ('headcount','sites','devices','stores')),
  unit         text not null check (length(unit) <= 40),
  value        integer not null check (value >= 0),
  fiscal_year  integer not null,
  unique (entity_id, driver_key, fiscal_year)
);

create table allocation_pools (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(name) <= 120),
  amount       numeric(18,4) not null,
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  driver_key   text not null check (driver_key in ('headcount','sites','devices','stores')),
  fiscal_year  integer not null,
  unique (name, fiscal_year)
);

-- ---------------------------------------------------------------------------
-- Template and cycle
-- ---------------------------------------------------------------------------

create table template_fields (
  id           uuid primary key default gen_random_uuid(),
  fiscal_year  integer not null,
  field_key    text not null check (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label        text not null check (length(label) <= 120),
  field_type   text not null check (field_type in ('text','select','money','note','file')),
  required     boolean not null default false,
  visible      boolean not null default true,
  position     integer not null,
  unique (fiscal_year, field_key)
);

create table cycles (
  fiscal_year               integer primary key check (fiscal_year between 2000 and 2100),
  phase                     text not null default 'collection'
                            check (phase in ('collection','review','locked','reforecast')),
  granularity               text not null default 'quarterly'
                            check (granularity in ('quarterly','monthly')),
  lock_date                 date,
  lock_enabled              boolean not null default false,
  headcount_planning        boolean not null default true,
  approval_threshold_eur    numeric(18,4) not null default 50000,
  updated_at                timestamptz not null default now()
);

create table cycle_exceptions (
  id           uuid primary key default gen_random_uuid(),
  fiscal_year  integer not null references cycles(fiscal_year),
  entity_id    uuid not null references entities(id) on delete cascade,
  reason       text not null check (length(reason) <= 500),
  granted_by   uuid not null references users(id),
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

create table validation_rules (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  description  text not null check (length(description) <= 300),
  severity     text not null check (severity in ('blocking','warning')),
  enabled      boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Workflow
-- ---------------------------------------------------------------------------

create table submissions (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entities(id) on delete cascade,
  fiscal_year   integer not null,
  submitted_by  uuid not null references users(id),
  submitted_at  timestamptz not null default now(),
  state         text not null default 'submitted'
                check (state in ('submitted','changes_requested','approved','rejected')),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  comment       text check (length(comment) <= 4000),
  -- SEC-012: the actor who submits can never be the actor who approves.
  constraint submission_sod check (decided_by is null or decided_by <> submitted_by)
);

create index submissions_entity_idx on submissions (entity_id, fiscal_year);

create table submission_line_decisions (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references submissions(id) on delete cascade,
  line_id        uuid not null references line_items(id) on delete cascade,
  decision       text not null check (decision in ('approved','rejected','info_requested')),
  comment        text check (length(comment) <= 2000),
  decided_by     uuid not null references users(id),
  decided_at     timestamptz not null default now(),
  unique (submission_id, line_id)
);

create table reminders (
  id           uuid primary key default gen_random_uuid(),
  target_role  text not null check (length(target_role) <= 64),
  message      text not null check (length(message) <= 2000),
  sent_by      uuid not null references users(id),
  sent_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Governance (SPEC §9)
-- ---------------------------------------------------------------------------

create table data_classifications (
  field_key   text primary key check (field_key ~ '^[a-z][a-z0-9_.]{0,127}$'),
  data_class  text not null check (data_class in ('public','internal','confidential','personal_data')),
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);

create table retention_policies (
  dataset     text primary key check (dataset in ('audit','budget','free_text','inactive_users')),
  months      integer not null check (months between 1 and 600),
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sessions (ZT-001, ZT-007)
-- ---------------------------------------------------------------------------

create table sessions (
  -- SHA-256 of the cookie value. The raw token is never stored, so a database
  -- read does not yield a usable session (ZT-006).
  id_hash          bytea primary key,
  user_id          uuid not null references users(id) on delete cascade,
  csrf_token_hash  bytea not null,
  created_at       timestamptz not null default now(),
  -- Time of the last successful primary authentication. Step-up compares
  -- against this rather than against session age (ZT-007).
  auth_time        timestamptz not null,
  expires_at       timestamptz not null,
  last_seen_at     timestamptz not null default now(),
  revoked_at       timestamptz,
  -- Claims carried from Conditional Access, re-checked per request so a
  -- policy misconfiguration fails closed (ZT-002, ZT-003).
  amr              text[] not null default '{}',
  device_compliant boolean not null default false,
  -- Salted hashes only: enough to detect session relocation, not enough to
  -- rebuild a browsing history (GDPR data minimisation, CMP-132).
  ip_hash          bytea,
  ua_hash          bytea
);

create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

-- OIDC transaction state, held server-side for the duration of a sign-in.
create table auth_transactions (
  state_hash     bytea primary key,
  code_verifier  text not null,
  nonce          text not null,
  redirect_path  text not null default '/',
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

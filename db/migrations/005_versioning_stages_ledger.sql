-- 005 Template versioning (FR-005), configurable approval stages (FR-051),
--     depreciation flow-through (FR-033) and ledger ingestion (FR-040).
--
-- Four features, one migration, because three of them touch `submissions` or
-- `line_items` and splitting them would mean two rewrites of the same tables.

-- ---------------------------------------------------------------------------
-- FR-005 Template versioning
--
-- A template version is a frozen field set. Fields belong to a version, not to
-- a fiscal year, and an entity records the version it started on. Publishing is
-- the only way to make a version usable, and a published version is immutable:
-- the CHECK below is what stops an "edit" from silently rewriting the template
-- under an in-flight budget.
-- ---------------------------------------------------------------------------

create table template_versions (
  id            uuid primary key default gen_random_uuid(),
  fiscal_year   integer not null check (fiscal_year between 2000 and 2100),
  version       integer not null check (version >= 1),
  state         text not null default 'draft' check (state in ('draft', 'published')),
  note          text check (length(note) <= 500),
  published_by  uuid references users(id),
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (fiscal_year, version),
  -- A published version has a publisher and a timestamp; a draft has neither.
  constraint publication_complete check (
    (state = 'draft'     and published_by is null and published_at is null) or
    (state = 'published' and published_by is not null and published_at is not null)
  )
);

create index template_versions_year_idx on template_versions (fiscal_year, version desc);

-- Backfill: everything that exists today is version 1, already published.
insert into template_versions (fiscal_year, version, state, note, published_at, published_by)
select distinct tf.fiscal_year, 1, 'published', 'Initial version (backfilled)', now(),
       (select id from users where role = 'admin' order by created_at limit 1)
from template_fields tf
on conflict do nothing;

alter table template_fields
  add column template_version_id uuid references template_versions(id) on delete cascade;

update template_fields tf
set template_version_id = tv.id
from template_versions tv
where tv.fiscal_year = tf.fiscal_year and tv.version = 1;

alter table template_fields alter column template_version_id set not null;

-- Uniqueness moves from (year, key) to (version, key): the same key may exist in
-- several versions with different labels, which is the point of versioning.
alter table template_fields drop constraint template_fields_fiscal_year_field_key_key;
alter table template_fields add constraint template_fields_version_key
  unique (template_version_id, field_key);

-- The version an entity's budget was started on. Null means "has not started",
-- and is resolved to the latest published version on first write.
alter table entities
  add column template_version_id uuid references template_versions(id);

update entities e
set template_version_id = tv.id
from template_versions tv
where tv.version = 1 and tv.fiscal_year = (
  select min(fiscal_year) from template_versions
);

-- ---------------------------------------------------------------------------
-- FR-051 Configurable approval stages
--
-- Stages are ordered, each carries a role condition and a threshold condition,
-- and each can be switched off without being deleted (so its history survives).
-- A stage applies to a submission when the submission's EUR total is at or above
-- `min_amount_eur`; a small budget can therefore skip a stage that a large one
-- must pass. `submissions.approved_at` is set only when every applicable stage
-- has approved — that is the gate FR-051 asks for, and it lives in
-- services/approval.ts rather than in the UI.
-- ---------------------------------------------------------------------------

create table approval_stages (
  id             uuid primary key default gen_random_uuid(),
  fiscal_year    integer not null check (fiscal_year between 2000 and 2100),
  position       integer not null check (position >= 1),
  name           text not null check (length(name) between 1 and 120),
  required_role  text not null check (required_role in (
                   'admin','cfo','finance_manager','cio','cto',
                   'infra_manager','security_manager','arch_manager','pmo')),
  min_amount_eur numeric(18,4) not null default 0 check (min_amount_eur >= 0),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (fiscal_year, position),
  unique (fiscal_year, name)
);

create table submission_stage_decisions (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references submissions(id) on delete cascade,
  stage_id       uuid not null references approval_stages(id),
  decision       text not null check (decision in ('approved','rejected','changes_requested')),
  comment        text check (length(comment) <= 4000),
  decided_by     uuid not null references users(id),
  decided_at     timestamptz not null default now(),
  unique (submission_id, stage_id)
);

create index submission_stage_decisions_submission_idx
  on submission_stage_decisions (submission_id);

-- SEC-012 in the schema, not only in the handler: the actor who submitted a
-- budget cannot record a stage decision on it. A trigger rather than a CHECK
-- because the submitter lives on the parent row.
create or replace function assert_stage_decision_sod() returns trigger
language plpgsql as $$
declare
  submitter uuid;
begin
  select submitted_by into submitter from submissions where id = new.submission_id;
  if submitter = new.decided_by then
    raise exception 'segregation of duties: the submitter cannot decide a stage (SEC-012)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger submission_stage_decisions_sod
  before insert or update on submission_stage_decisions
  for each row execute function assert_stage_decision_sod();

-- Seeded default: the single CFO stage the application had hard-coded before
-- this migration, so behaviour is unchanged until an administrator adds one.
insert into approval_stages (fiscal_year, position, name, required_role, min_amount_eur)
select fiscal_year, 1, 'CFO review', 'cfo', 0 from cycles
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- FR-033 Depreciation flow-through
--
-- Next year's depreciation charge becomes next year's opex plan. The charge is
-- derived, so the line that carries it is derived too: `derived_from_line_id`
-- points at the capex line that generated it, and a derived line is read-only
-- to everyone (enforced in services/editability.ts, the same place that makes a
-- driver-linked amount read-only under FR-021).
-- ---------------------------------------------------------------------------

alter table cycles
  add column depreciation_flow_through boolean not null default false;

alter table line_items
  add column derived_from_line_id uuid references line_items(id) on delete cascade,
  add column derived_kind         text check (derived_kind in ('depreciation'));

-- Both columns or neither: a derived line must say what derived it.
alter table line_items add constraint derived_link_complete check (
  (derived_from_line_id is null and derived_kind is null) or
  (derived_from_line_id is not null and derived_kind is not null)
);

-- Regeneration is idempotent: one derived line per (source line, kind).
create unique index line_items_derived_unique
  on line_items (derived_from_line_id, derived_kind)
  where derived_from_line_id is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- FR-040 Ledger ingestion
--
-- A batch is the unit of idempotency. `external_ref` is the feed's own
-- identifier for the extract; replaying a batch returns the first result
-- instead of double-posting, which is what makes a nightly job safe to retry.
-- Rejected rows are kept rather than discarded, because "the ledger sent us 40
-- rows we could not match" is the finding, not a log line.
-- ---------------------------------------------------------------------------

create table ledger_batches (
  id              uuid primary key default gen_random_uuid(),
  external_ref    text not null unique check (external_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  fiscal_year     integer not null check (fiscal_year between 2000 and 2100),
  source_system   text not null check (length(source_system) between 1 and 64),
  received_by     uuid not null references users(id),
  received_at     timestamptz not null default now(),
  row_count       integer not null check (row_count >= 0),
  accepted_count  integer not null check (accepted_count >= 0),
  rejected_count  integer not null check (rejected_count >= 0),
  status          text not null check (status in ('accepted','partial','rejected')),
  constraint batch_counts_add_up check (accepted_count + rejected_count = row_count)
);

create table ledger_batch_rejects (
  id        uuid primary key default gen_random_uuid(),
  batch_id  uuid not null references ledger_batches(id) on delete cascade,
  row_index integer not null check (row_index >= 0),
  -- The feed's own reference for the row. Kept as text: it is opaque to us.
  line_ref  text check (length(line_ref) <= 128),
  period    integer,
  reason    text not null check (length(reason) <= 300)
);

create index ledger_batch_rejects_batch_idx on ledger_batch_rejects (batch_id);

alter table actuals
  add column ledger_batch_id uuid references ledger_batches(id),
  add column ledger_ref      text check (length(ledger_ref) <= 128);

-- A ledger-sourced actual carries its batch; a manual one never does. This is
-- what lets services/editability.ts refuse a hand edit to a ledger-owned period
-- without trusting the `source` column alone.
alter table actuals add constraint ledger_provenance check (
  (source = 'ledger' and ledger_batch_id is not null) or
  (source = 'manual' and ledger_batch_id is null and ledger_ref is null)
);

-- A stable external key for a line, so a feed can address lines without knowing
-- our UUIDs. Nullable: lines created before a feed exists have none.
alter table line_items
  add column ledger_ref text check (length(ledger_ref) <= 128);

create unique index line_items_ledger_ref_unique
  on line_items (entity_id, ledger_ref)
  where ledger_ref is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Grants for the new tables (SEC-021). The application writes them all; none
-- carries DDL. Rejects are insert-and-read only — nothing amends a reject.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on
  template_versions, approval_stages, submission_stage_decisions, ledger_batches
to spendifre_app;

grant select, insert on ledger_batch_rejects to spendifre_app;

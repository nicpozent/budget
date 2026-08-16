-- 004 Backup manifests.
--
-- The manifest lives in the database; the archive itself does not. What is
-- recorded here is everything needed to *reason* about a backup without
-- reading it: what it covered, how big it was, whether its integrity still
-- verifies, and — the part that matters for financial control — whether the
-- audit hash chain was intact at the moment it was taken.
--
-- A backup that captured a broken chain is evidence of when the break happened.
-- A backup with no such record is just a file.

create table backups (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  created_by     uuid not null references users(id),
  -- The deployment's region at the time. A backup must not be restored into a
  -- different residency (SPEC §9.4, CMP-140), so the constraint travels with it.
  region         text not null check (region in ('eu','ch','apac','cn')),

  status         text not null default 'complete'
                 check (status in ('complete','failed')),

  byte_size      bigint not null default 0,
  -- SHA-256 of the *encrypted* archive as written to storage, so integrity can
  -- be checked without holding the decryption key.
  sha256         bytea,
  -- AES-256-GCM parameters. The key itself is never stored — it comes from the
  -- environment, which in production means Key Vault (ZT-006).
  iv             bytea,
  auth_tag       bytea,

  -- Per-table row counts, so a restore can be reconciled against expectation.
  row_counts     jsonb not null default '{}'::jsonb,

  -- CMP-103 tamper evidence, captured at backup time.
  audit_head_seq bigint,
  audit_chain_intact boolean,

  -- Opaque storage key. Derived from `id`, never from user input, so there is
  -- no path to traverse.
  storage_key    text not null,

  error          text check (length(error) <= 1000)
);

create index backups_created_idx on backups (created_at desc);

grant select, insert, update on backups to spendifre_app;

-- Backups are business records of an operational action, not audit rows; they
-- may be pruned by retention like any other dataset. Widen the CHECK first —
-- it predates this dataset and would reject the row below.
alter table retention_policies drop constraint retention_policies_dataset_check;
alter table retention_policies add constraint retention_policies_dataset_check
  check (dataset in ('audit','budget','free_text','inactive_users','backups'));

insert into retention_policies (dataset, months)
values ('backups', 24)
on conflict (dataset) do nothing;

-- 008 Budget versions and scenarios (FR-080), and derived drivers (FR-020).
--
-- SPEC §11 defers versions and scenarios out of v1 and asks only that the
-- schema not preclude them: "amounts should be addressable by
-- (line, period, version) from day one, even if v1 only ever writes
-- version = 'working'". That is what 001 did, and this is the increment the
-- deferral was written to make cheap. It is being built at the product owner's
-- explicit request; the deferral is recorded in SPEC §11 and this migration is
-- the answer to it, not an oversight of it.
--
-- The point of the exercise: `budget_version` has been a free-text column with
-- a length check. Anything could write anything into it, a typo made a silent
-- second scenario, and nothing said which versions existed. This gives the
-- dimension a table, a foreign key and a lock.

create table budget_versions (
  fiscal_year   integer not null references cycles(fiscal_year),
  -- The key that appears in period_amounts.budget_version. Constrained to a
  -- slug so it can go in a URL and a filename without escaping.
  key           text not null check (key ~ '^[a-z][a-z0-9_-]{0,31}$'),
  label         text not null check (length(label) between 1 and 120),
  -- 'working' is the live plan everyone edits. 'baseline' is a frozen copy
  -- taken at a point in the cycle. 'scenario' is a what-if. 'forecast' is a
  -- rolling forecast, rebased from actuals.
  kind          text not null check (kind in ('working','baseline','scenario','forecast')),
  description   text check (length(description) <= 500),
  -- A locked version is a record rather than a workspace. Enforced by trigger
  -- below, not only by the handler, for the same reason INV-5 is: the rule has
  -- to hold for anything holding the app role, including a future job.
  locked        boolean not null default false,
  -- The version this one was copied from, for provenance. Deliberately not a
  -- foreign key: the source may later be deleted, and losing the record of
  -- where a scenario came from would be worse than a dangling name.
  copied_from   text,
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now(),
  locked_at     timestamptz,
  primary key (fiscal_year, key)
);

-- Exactly one working version per year. The whole application treats "working"
-- as the thing being edited; two of them would make that ambiguous.
create unique index budget_versions_one_working_idx
  on budget_versions (fiscal_year) where kind = 'working';

-- Every cycle that exists gets its working version, so the foreign key below
-- can be added without orphaning anything already stored.
insert into budget_versions (fiscal_year, key, label, kind, description, created_by)
select c.fiscal_year, 'working', 'Working plan', 'working',
       'The live plan. Every edit lands here.',
       (select id from users where role = 'admin' order by created_at limit 1)
from cycles c
on conflict do nothing;

-- Any version string already in use that is not declared becomes a scenario
-- rather than a constraint violation. In a fresh database this selects nothing;
-- in one where a tool wrote 'baseline' directly, it keeps the data and gives it
-- a name.
insert into budget_versions (fiscal_year, key, label, kind, description, created_by)
select distinct pa.fiscal_year, pa.budget_version, pa.budget_version, 'scenario',
       'Adopted by migration 008 from amounts that predate the version table.',
       (select id from users where role = 'admin' order by created_at limit 1)
from period_amounts pa
join cycles c on c.fiscal_year = pa.fiscal_year
where pa.budget_version ~ '^[a-z][a-z0-9_-]{0,31}$'
on conflict do nothing;

alter table period_amounts
  add constraint period_amounts_version_fk
  foreign key (fiscal_year, budget_version)
  references budget_versions (fiscal_year, key)
  on delete cascade;

-- Deleting a scenario should take its amounts with it; deleting the working
-- version should be impossible. The cascade above does the first, this does
-- the second.
create or replace function budget_versions_protect() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.kind = 'working' then
      raise exception 'the working version cannot be deleted';
    end if;
    if old.locked then
      raise exception 'version % is locked', old.key;
    end if;
    return old;
  end if;
  -- Unlocking is allowed (an administrator may need to correct a mistake) but
  -- changing the kind of an existing version is not: a baseline that could
  -- become the working plan would let a frozen record be edited.
  if new.kind <> old.kind then
    raise exception 'a version kind cannot be changed after creation';
  end if;
  return new;
end;
$$;

create trigger budget_versions_protect_trg
  before update or delete on budget_versions
  for each row execute function budget_versions_protect();

-- The lock, in data. A handler check would be enough for the UI and not enough
-- for anything else holding the application role.
create or replace function period_amounts_version_unlocked() returns trigger
language plpgsql as $$
declare
  is_locked boolean;
  target_year integer;
  target_version text;
begin
  target_year := coalesce(new.fiscal_year, old.fiscal_year);
  target_version := coalesce(new.budget_version, old.budget_version);
  select bv.locked into is_locked from budget_versions bv
   where bv.fiscal_year = target_year and bv.key = target_version;
  if is_locked then
    raise exception 'budget version % for FY% is locked', target_version, target_year;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger period_amounts_version_unlocked_trg
  before insert or update or delete on period_amounts
  for each row execute function period_amounts_version_unlocked();

-- ---------------------------------------------------------------------------
-- Derived drivers (FR-020 driver trees)
-- ---------------------------------------------------------------------------
--
-- A driver may now be defined as a multiple of another driver for the same
-- entity and year — devices per head, sites per store — instead of only being
-- typed in. The resolved figure is still stored in `value`, so every read path
-- (the grid, the SQL fold, the allocation report) is unchanged and a tree
-- cannot make a report slower or a total disagree with itself.
--
-- Acyclicity is not expressible as a CHECK. Self-reference is, and is blocked
-- here; longer cycles are refused by `resolveDriverTree` before a write, and
-- the runtime self-test re-derives every derived value against its parent so a
-- tree that stopped agreeing with its definition is a failing check rather
-- than a wrong number.

alter table drivers
  add column derived_from text
    check (derived_from is null or derived_from in ('headcount','sites','devices','stores')),
  add column factor numeric(18,4)
    check (factor is null or factor >= 0),
  -- Both or neither: a parent with no factor has no definition, and a factor
  -- with no parent has nothing to multiply.
  add constraint drivers_derivation_complete
    check ((derived_from is null) = (factor is null)),
  add constraint drivers_no_self_reference
    check (derived_from is null or derived_from <> driver_key);

grant select, insert, update, delete on budget_versions to spendifre_app;

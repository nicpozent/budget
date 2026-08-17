-- 009 Make the FR-080 version lock a statement-level check.
--
-- Migration 008 enforced the lock with a BEFORE ... FOR EACH ROW trigger, which
-- is the obvious shape and the wrong one for this table. Every write to
-- `period_amounts` is a bulk write: copying a scenario is 7,056 rows, a ledger
-- batch is up to 5,000, and the load-test amplification is 21,000. A per-row
-- trigger ran one lookup against `budget_versions` for each of them.
--
-- Measured on the load-test database: copying a scenario took 258 ms, almost
-- all of it in the trigger. The reporting path was measured to death; this one
-- was not, and it is the one the new feature actually added.
--
-- A statement-level AFTER trigger with a transition table does the same check
-- as one join, once. AFTER rather than BEFORE because transition tables are
-- only available to AFTER triggers — and that is fine here, because the raise
-- aborts the transaction either way. The rule is unchanged: no write to a
-- locked version, whoever holds the application role.

drop trigger if exists period_amounts_version_unlocked_trg on period_amounts;
drop function if exists period_amounts_version_unlocked();

/*
 * One row is enough to refuse the statement, so each of these stops at the
 * first locked version it finds and names it.
 */
create or replace function period_amounts_locked_target() returns trigger
language plpgsql as $$
declare
  bad_key text;
  bad_year integer;
begin
  select bv.key, bv.fiscal_year into bad_key, bad_year
  from changed c
  join budget_versions bv
    on bv.fiscal_year = c.fiscal_year and bv.key = c.budget_version
  where bv.locked
  limit 1;

  if bad_key is not null then
    raise exception 'budget version % for FY% is locked', bad_key, bad_year;
  end if;
  return null;
end;
$$;

-- INSERT and UPDATE look at the rows as they will be; DELETE at the rows as
-- they were. UPDATE needs both, because moving a row *into* a locked version
-- and deleting one *out of* a locked version are both writes to it.
--
-- The transition table is aliased to the same name in every case so one
-- function serves all four triggers.
create trigger period_amounts_locked_insert_trg
  after insert on period_amounts
  referencing new table as changed
  for each statement execute function period_amounts_locked_target();

create trigger period_amounts_locked_update_new_trg
  after update on period_amounts
  referencing new table as changed
  for each statement execute function period_amounts_locked_target();

create trigger period_amounts_locked_update_old_trg
  after update on period_amounts
  referencing old table as changed
  for each statement execute function period_amounts_locked_target();

-- On DELETE the join finds nothing when the version row itself is being
-- deleted, because a foreign-key cascade runs after the parent row is gone.
-- That is correct rather than lucky: deleting a *locked* version is refused by
-- `budget_versions_protect` before any of this runs, so the only cascades that
-- reach here belong to versions that were unlocked.
create trigger period_amounts_locked_delete_trg
  after delete on period_amounts
  referencing old table as changed
  for each statement execute function period_amounts_locked_target();

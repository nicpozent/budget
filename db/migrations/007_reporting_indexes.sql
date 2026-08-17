-- 007 Indexes for the reporting path (NFR-001).
--
-- Added in response to a measurement, not a guess. `tools/loadtest.ts` at
-- monthly × three-version scale — 30,576 period rows rather than the 7,056 a
-- quarterly single-version fixture carries — put four of six report routes over
-- the 300 ms p95 budget, the worst at 691 ms.
--
-- The cause was visible in one plan: every report filters `period_amounts` by
-- (fiscal_year, budget_version) and joins by line, but the primary key is
-- (line_id, fiscal_year, period, budget_version). A query with no line_id
-- cannot use a key that starts with one, so each report sequentially scanned
-- the whole table and discarded three quarters of it.
--
-- These are covering indexes: the payload columns are in the INCLUDE clause, so
-- the reports can be answered from the index without visiting the heap at all.

-- The hot path. Every consolidation, trend, variance and consumption query
-- starts here.
create index period_amounts_year_version_idx
  on period_amounts (fiscal_year, budget_version)
  include (line_id, period, amount);

-- Actuals are filtered the same way by FR-042 and FR-043.
create index actuals_year_idx
  on actuals (fiscal_year)
  include (line_id, period, amount, source);

-- `loadLines` filters by entity and excludes soft-deleted rows. A partial index
-- keeps it small: deleted lines are a minority that no report ever wants.
create index line_items_entity_live_idx
  on line_items (entity_id)
  include (category_id, currency, cost_type)
  where deleted_at is null;

-- FR-071 audit reads are scoped and ordered by time; the full-text index
-- already exists for FR-072 search, but not this.
create index audit_events_entity_time_idx
  on audit_events (entity_id, occurred_at desc);

-- The retention job and the ZT-008 export alert both scan by action and date.
create index audit_events_action_time_idx
  on audit_events (action, occurred_at desc);

-- Planner statistics: `period_amounts` grows by a factor of the period
-- granularity and the version count, and the default sample can under-estimate
-- the correlation between fiscal_year and budget_version enough to pick the
-- wrong join order.
alter table period_amounts alter column fiscal_year set statistics 500;
alter table period_amounts alter column budget_version set statistics 500;

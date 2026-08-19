-- 010 Driver trees that combine several sources (FR-020).
--
-- Migration 008 let a driver be a multiple of exactly one other driver, which
-- covers "devices per head" and does not cover the shape most real driver
-- models take: devices = 1.5 per head + 2 per site. The evaluation named it —
-- "driver trees multiply one parent rather than combining several" — and this
-- is that gap closed.
--
-- What this deliberately is *not* is a formula engine. A term is a row: a
-- source driver and a factor. There is no expression, nothing is parsed, and
-- nothing user-supplied is interpreted. Addition and multiplication by a
-- constant are the two operations, they are structure rather than syntax, and
-- ADR 0007's argument against an expression language is untouched by this.

create table driver_terms (
  entity_id    uuid not null references entities(id) on delete cascade,
  fiscal_year  integer not null,
  driver_key   text not null check (driver_key in ('headcount','sites','devices','stores')),
  source_key   text not null check (source_key in ('headcount','sites','devices','stores')),
  -- Bounded above so a tree cannot produce an absurd headcount, and strictly
  -- positive because a zero-factor term is a term that does nothing.
  factor       numeric(18,4) not null check (factor > 0 and factor <= 1000),

  primary key (entity_id, fiscal_year, driver_key, source_key),
  -- One-hop self-reference, which a CHECK can express. Longer cycles cannot be
  -- expressed here and are refused by `resolveDriverTree` inside the writing
  -- transaction; the self-test re-derives every value so a tree that stopped
  -- agreeing with its definition is a failing check rather than a wrong budget.
  constraint driver_terms_no_self_reference check (source_key <> driver_key),
  -- A term belongs to a driver the entity actually has.
  constraint driver_terms_driver_fk
    foreign key (entity_id, driver_key, fiscal_year)
    references drivers (entity_id, driver_key, fiscal_year) on delete cascade
);

create index driver_terms_source_idx
  on driver_terms (entity_id, fiscal_year, source_key);

-- Carry the single-term definitions forward. In a fresh database this selects
-- nothing; where 008 has already run it preserves every tree that exists.
insert into driver_terms (entity_id, fiscal_year, driver_key, source_key, factor)
select entity_id, fiscal_year, driver_key, derived_from, factor
from drivers
where derived_from is not null and factor is not null and factor > 0
on conflict do nothing;

-- One representation, not two. Leaving the old columns would leave a second
-- place to say the same thing, and a second place is the one that gets
-- forgotten -- which is the lesson recorded on `visibleEntityIds`.
alter table drivers
  drop constraint if exists drivers_derivation_complete,
  drop constraint if exists drivers_no_self_reference,
  drop column if exists derived_from,
  drop column if exists factor;

grant select, insert, update, delete on driver_terms to spendifre_app;

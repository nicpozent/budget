-- 011 An entity has a country, and residency is derived from it.
--
-- `entities.residency` is one of four buckets — eu, ch, apac, cn — and that is
-- all the model knew about where an entity is. A bucket is not a country.
-- `apac` covers Singapore, India and Vietnam, so a deployment could serve all
-- three or none of them and had no way to say "Singapore but not Vietnam".
-- The same gap made the entity list unable to group by country, which is the
-- cut a group IT budget is most often read along.
--
-- The fix is to record the fact rather than the bucket. `country` is the fact:
-- ISO 3166-1 alpha-2, one per entity. `residency` stays on the row, but stops
-- being independently writable — a composite foreign key ties the pair to a
-- row in `countries`, so a Vietnamese entity classified `eu` is refused by the
-- database rather than caught by a reviewer.
--
-- Keeping the derived column at all is deliberate. Every read path filters on
-- residency, and that filter is the hot predicate in the reporting fold
-- (NFR-001); resolving it through a join on every query would put a second
-- table in the path of work that was just measured down to budget. The foreign
-- key is what makes the denormalisation safe to keep.
--
-- Adding a country, or moving one between buckets, is a migration. That is the
-- intent: which jurisdiction's data sits in which bucket is a decision someone
-- reviews, not a value an operator types into a form.

create table countries (
  code       char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name       text not null check (length(name) <= 100),
  residency  text not null check (residency in ('eu','ch','apac','cn')),
  -- Redundant as a constraint, since `code` is already unique on its own.
  -- It exists because a composite foreign key needs a unique index covering
  -- exactly the columns it references.
  unique (code, residency)
);

comment on table countries is
  'Countries the group operates in, and the residency bucket each one falls in.';

insert into countries (code, name, residency) values
  ('SE', 'Sweden',      'eu'),
  ('NO', 'Norway',      'eu'),
  ('DK', 'Denmark',     'eu'),
  ('FI', 'Finland',     'eu'),
  ('NL', 'Netherlands', 'eu'),
  ('DE', 'Germany',     'eu'),
  ('CH', 'Switzerland', 'ch'),
  ('SG', 'Singapore',   'apac'),
  ('IN', 'India',       'apac'),
  ('VN', 'Vietnam',     'apac'),
  ('CN', 'China',       'cn');

alter table entities add column country char(2);

-- Backfill. Where a currency is used by exactly one country the group operates
-- in, the country follows from the currency and no fact is being invented.
update entities e
set country = m.code
from (values
  ('SEK','SE'), ('NOK','NO'), ('DKK','DK'), ('CHF','CH'),
  ('SGD','SG'), ('INR','IN'), ('VND','VN'), ('CNY','CN')
) as m(currency, code)
where e.currency = m.currency and e.country is null;

-- EUR and USD are not one country's currency, so anything still unset is a fact
-- this migration does not have. Refusing here is the point: guessing would put
-- a wrong jurisdiction on a row and every later check would agree with it.
-- Set `entities.country` for the rows named below, then re-run.
do $$
declare unmapped text;
begin
  select string_agg(code, ', ' order by code) into unmapped
  from entities where country is null;

  if unmapped is not null then
    raise exception
      'entities.country cannot be inferred for: %. Set it explicitly (see countries) and re-run migration 011.',
      unmapped;
  end if;
end $$;

alter table entities
  alter column country set not null,
  add constraint entities_country_fk
    foreign key (country) references countries (code),
  -- The pair, not just the country: this is what makes `residency` derived
  -- rather than a second independently-editable opinion about the same entity.
  add constraint entities_country_residency_fk
    foreign key (country, residency) references countries (code, residency);

create index entities_country_idx on entities (country);

-- Reference data, maintained by migration. The application reads it — to list
-- the choices on the entity form and to resolve a new entity's bucket — and
-- never writes it.
grant select on countries to spendifre_app;

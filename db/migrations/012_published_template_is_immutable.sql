-- 012 A published template version is immutable in the database, not only in
--     the application (FR-005).
--
-- Migration 005's header says "a published version is immutable: the CHECK
-- below is what stops an edit from silently rewriting the template under an
-- in-flight budget". That is not what the CHECK does. `publication_complete`
-- says a published row has a publisher and a timestamp and a draft has
-- neither; it says nothing about the fields, and nothing about going back.
--
-- What actually enforced immutability was two `if (state === 'published')`
-- guards in `routes/template.ts`. Those are correct and they are tested, but
-- they are the only thing standing between a published template and an edit.
-- `spendifre_app` holds UPDATE and DELETE on `template_fields`, so any new code
-- path that forgets the guard rewrites a frozen template with no complaint from
-- anywhere — and the thing being rewritten is what an already-approved budget
-- was filled in against.
--
-- 005 cannot be edited; its checksum is recorded and the runner refuses a
-- changed file. So the correction is here, and it is the mechanism rather than
-- the comment: the claim 005 makes is now true.
--
-- Statement-level with transition tables, matching migration 009 — the check
-- runs once per statement rather than once per row, and a bulk update is caught
-- as a bulk update.

create or replace function assert_template_version_mutable() returns trigger
language plpgsql
as $$
declare frozen text;
begin
  select string_agg(distinct tv.version::text, ', ' order by tv.version::text)
    into frozen
  from changed c
  join template_versions tv on tv.id = c.template_version_id
  where tv.state = 'published';

  if frozen is not null then
    raise exception
      'template version % is published and immutable (FR-005) — open a new draft',
      frozen;
  end if;
  return null;
end $$;

create trigger template_fields_no_insert_into_published
  after insert on template_fields
  referencing new table as changed
  for each statement execute function assert_template_version_mutable();

-- Two update triggers, one over each side of the change. The OLD side refuses
-- editing a field that belongs to a published version; the NEW side refuses
-- moving a field *into* one, which the OLD side cannot see.
create trigger template_fields_no_update_of_published
  after update on template_fields
  referencing old table as changed
  for each statement execute function assert_template_version_mutable();

create trigger template_fields_no_move_into_published
  after update on template_fields
  referencing new table as changed
  for each statement execute function assert_template_version_mutable();

create trigger template_fields_no_delete_from_published
  after delete on template_fields
  referencing old table as changed
  for each statement execute function assert_template_version_mutable();

-- And the version row itself. Publishing is draft -> published, which this
-- permits because it looks at the row as it was; every other write to a
-- published version, including unpublishing it, is refused.
create or replace function assert_published_version_frozen() returns trigger
language plpgsql
as $$
declare frozen text;
begin
  select string_agg(distinct version::text, ', ' order by version::text) into frozen
  from changed where state = 'published';

  if frozen is not null then
    raise exception
      'template version % is published and cannot be changed or removed (FR-005)',
      frozen;
  end if;
  return null;
end $$;

create trigger template_versions_no_update_of_published
  after update on template_versions
  referencing old table as changed
  for each statement execute function assert_published_version_frozen();

create trigger template_versions_no_delete_of_published
  after delete on template_versions
  referencing old table as changed
  for each statement execute function assert_published_version_frozen();

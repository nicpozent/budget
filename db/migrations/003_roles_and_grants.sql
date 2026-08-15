-- 003 Least-privilege database roles (SEC-021).
--
-- Three roles, three jobs:
--   spendifre_migrator  owns the schema, holds DDL. Migrations run as this role.
--   spendifre_app       the application. DML only, no DDL, no DELETE on audit.
--   spendifre_retention runs the retention job. Executes the purge function,
--                       nothing else.
--
-- Passwords are not set here. In Azure these roles authenticate with a managed
-- identity token (ZT-005, ZT-006); the local development bootstrap sets a
-- password out of band and never commits it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'spendifre_app') then
    create role spendifre_app login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'spendifre_retention') then
    create role spendifre_retention login;
  end if;
end
$$;

-- Deny by default: strip the implicit PUBLIC grant before adding anything back.
revoke all on schema public from public;
revoke all on all tables in schema public from public;
revoke all on all functions in schema public from public;

grant usage on schema public to spendifre_app, spendifre_retention;

-- The application may read and write business data.
grant select, insert, update, delete on
  entities, entity_owners, categories, cost_centres, line_items,
  period_amounts, actuals, line_comments, fx_rates, drivers,
  allocation_pools, template_fields, cycles, cycle_exceptions,
  validation_rules, submissions, submission_line_decisions, reminders,
  data_classifications, retention_policies, sessions, auth_transactions, users
to spendifre_app;

grant usage, select on all sequences in schema public to spendifre_app;

-- Audit is append-only for the application. No UPDATE, no DELETE — the trigger
-- would refuse anyway, but the grant means the attempt never reaches it.
grant select, insert on audit_events to spendifre_app;
grant select on audit_chain_anchor to spendifre_app;
grant execute on function audit_verify_chain() to spendifre_app;

-- No DDL for the application role: it does not own the schema, and CREATE on
-- the public schema is not granted.
revoke create on schema public from spendifre_app;

-- The retention job executes the purge and nothing else. audit_purge_expired
-- is SECURITY DEFINER, so it carries the owner's DELETE right without the
-- caller ever holding it.
grant execute on function audit_purge_expired() to spendifre_retention;
grant select on retention_policies to spendifre_retention;
grant select, delete on line_comments to spendifre_retention;
grant select, update on users to spendifre_retention;

-- Belt and braces: even the owner cannot UPDATE audit rows, because the
-- trigger refuses regardless of role.
revoke update, delete on audit_events from spendifre_app;

-- 002 Append-only, tamper-evident audit trail (FR-070..FR-073, CMP-103).
--
-- Three independent controls, because any one of them can be misconfigured:
--   1. Grants        — the application role holds INSERT and SELECT only (SEC-021).
--   2. Trigger       — UPDATE is refused unconditionally; DELETE only from the
--                      retention job, and only for rows past their retention.
--   3. Hash chain    — each row commits to its predecessor, so a deletion or
--                      edit performed out-of-band (a superuser, a restored
--                      backup) is detectable rather than merely prevented.

create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  -- Chain order. A gap in this sequence is itself evidence.
  seq           bigserial not null unique,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid not null references users(id),
  -- The role as it was at the time of the action. Denormalised deliberately:
  -- a later role change must not rewrite history.
  actor_role    text not null,
  action        text not null check (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
  target_type   text not null check (target_type ~ '^[a-z][a-z0-9_]{0,31}$'),
  target_id     uuid,
  -- Denormalised so FR-071 scoping and retention can filter without joining
  -- to rows that may themselves have been purged.
  entity_id     uuid,
  detail        text not null check (length(detail) <= 4000),
  kind          text not null check (kind in ('change','approval','workflow','governance')),
  prev_hash     bytea not null,
  row_hash      bytea not null
);

create index audit_events_actor_idx on audit_events (actor_user_id, seq desc);
create index audit_events_kind_idx on audit_events (kind, seq desc);
create index audit_events_entity_idx on audit_events (entity_id, seq desc);
-- FR-072 full-text search, so that search never becomes a reason to build a
-- LIKE query out of concatenated input.
create index audit_events_search_idx on audit_events
  using gin (to_tsvector('simple', action || ' ' || target_type || ' ' || detail));

-- Genesis anchor: the chain starts from a fixed, known value so that an empty
-- table cannot be forged into a "valid" chain of length zero.
create table audit_chain_anchor (
  singleton  boolean primary key default true check (singleton),
  head_hash  bytea not null,
  head_seq   bigint not null default 0,
  anchored_at timestamptz not null default now()
);

insert into audit_chain_anchor (head_hash, head_seq)
values (digest('spendifre-audit-genesis', 'sha256'), 0);

create or replace function audit_link() returns trigger
language plpgsql as $$
declare
  prev bytea;
begin
  -- Serialise audit appends so concurrent inserts cannot interleave and
  -- produce two rows claiming the same predecessor.
  perform pg_advisory_xact_lock(hashtext('spendifre.audit_chain'));

  select row_hash into prev from audit_events order by seq desc limit 1;
  if prev is null then
    select head_hash into prev from audit_chain_anchor where singleton;
  end if;

  new.prev_hash := prev;
  new.row_hash := digest(
    prev
      || convert_to(coalesce(new.occurred_at::text, ''), 'UTF8')
      || convert_to(new.actor_user_id::text, 'UTF8')
      || convert_to(new.actor_role, 'UTF8')
      || convert_to(new.action, 'UTF8')
      || convert_to(new.target_type, 'UTF8')
      || convert_to(coalesce(new.target_id::text, ''), 'UTF8')
      || convert_to(coalesce(new.entity_id::text, ''), 'UTF8')
      || convert_to(new.detail, 'UTF8')
      || convert_to(new.kind, 'UTF8'),
    'sha256');
  return new;
end;
$$;

create trigger audit_link_before_insert
  before insert on audit_events
  for each row execute function audit_link();

-- FR-073. UPDATE is never permitted. DELETE is permitted only from inside the
-- retention function, which sets the GUC below and checks the age itself; the
-- trigger re-checks the age so a leaked GUC still cannot purge recent history.
create or replace function audit_immutable() returns trigger
language plpgsql as $$
declare
  retention_months integer;
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_events is append-only (FR-073)'
      using errcode = 'restrict_violation';
  end if;

  if coalesce(current_setting('spendifre.retention_job', true), 'off') <> 'on' then
    raise exception 'audit_events may only be purged by the retention job (FR-073, PRIV-001)'
      using errcode = 'restrict_violation';
  end if;

  select months into retention_months from retention_policies where dataset = 'audit';
  if retention_months is null then
    raise exception 'no audit retention policy configured'
      using errcode = 'restrict_violation';
  end if;

  if old.occurred_at > now() - make_interval(months => retention_months) then
    raise exception 'audit event is inside its retention period'
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

create trigger audit_immutable_guard
  before update or delete on audit_events
  for each row execute function audit_immutable();

-- Verifies the chain from the anchor to the head. Returns the seq of the first
-- row that does not match, or null when the chain is intact. Run by the
-- monitoring job; an alert on a non-null result is ZT-008's audit-write-failure
-- signal.
create or replace function audit_verify_chain() returns bigint
language plpgsql stable as $$
declare
  expected bytea;
  r record;
  computed bytea;
begin
  select head_hash into expected from audit_chain_anchor where singleton;
  for r in select * from audit_events order by seq loop
    if r.prev_hash is distinct from expected then
      return r.seq;
    end if;
    computed := digest(
      r.prev_hash
        || convert_to(r.occurred_at::text, 'UTF8')
        || convert_to(r.actor_user_id::text, 'UTF8')
        || convert_to(r.actor_role, 'UTF8')
        || convert_to(r.action, 'UTF8')
        || convert_to(r.target_type, 'UTF8')
        || convert_to(coalesce(r.target_id::text, ''), 'UTF8')
        || convert_to(coalesce(r.entity_id::text, ''), 'UTF8')
        || convert_to(r.detail, 'UTF8')
        || convert_to(r.kind, 'UTF8'),
      'sha256');
    if computed is distinct from r.row_hash then
      return r.seq;
    end if;
    expected := r.row_hash;
  end loop;
  return null;
end;
$$;

-- PRIV-001. SECURITY DEFINER so the purge runs with the owner's DELETE right
-- while the application role has none. Re-anchors the chain to the new head so
-- verification still starts from a trusted value after a legitimate purge.
create or replace function audit_purge_expired() returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  purged integer;
  new_head bytea;
  new_seq bigint;
begin
  perform set_config('spendifre.retention_job', 'on', true);

  with cutoff as (
    select now() - make_interval(months => (select months from retention_policies where dataset = 'audit')) as ts
  )
  delete from audit_events where occurred_at <= (select ts from cutoff);
  get diagnostics purged = row_count;

  select row_hash, seq into new_head, new_seq from audit_events order by seq limit 1;
  if new_head is not null then
    -- The surviving head's prev_hash points at a purged row; re-anchor to it
    -- so the chain remains verifiable from a recorded, audited value.
    update audit_chain_anchor
       set head_hash = (select prev_hash from audit_events order by seq limit 1),
           head_seq = new_seq - 1,
           anchored_at = now()
     where singleton;
  end if;

  perform set_config('spendifre.retention_job', 'off', true);
  return purged;
end;
$$;

# ADR 0006 — Route modules by domain, services by layer

**Status:** Accepted
**Date:** 2026-08-16
**Supersedes:** the "revisit if the domain grows" note in ADR 0001

## Context

The original structure split `packages/api/src` by technical layer —
`routes/`, `services/`, `http/`, `db/`, `auth/`. ADR 0001 recorded that as right
at the size the application then was, with an explicit condition attached: *"If
the domain grows past what one person can hold, feature slices under
`src/features/` would be the next move; it is not worth the churn yet."*

The application evaluation carried that forward as a gap on architecture and
modularity: **"Layer-split rather than feature-split — right at this size,
revisit if the domain grows."**

The domain then grew. Closing four functional gaps — template versioning
(FR-005), configurable approval stages (FR-051), depreciation flow-through
(FR-033) and ledger ingestion (FR-040) — added four subsystems. Adding them to
the existing files would have taken `routes/admin.ts` past 1,000 lines and
`routes/workflow.ts` past 700, and `admin.ts` would then have held template
definition, cost centres, entities, FX, drivers, allocations, governance,
data-subject requests, retention and backups: a file whose name means "the rest".

So the condition ADR 0001 set has been met, and this ADR records what was
actually done about it.

## Decision

**Routes are organised by domain. Services and infrastructure remain organised
by layer.**

```
routes/     auth  meta  lines  workflow  approvals  template  ledger  versions
            reference  drivers  governance  operations  reports  audit  shell
services/   approval  audit  backup  budget  depreciation  drivers  editability
            residency  restore  selftest  versions  xlsx
observability/  logging  metrics  tracing
http/       guard  security  errors  validate
db/         pool  migrate  seed  dataset
auth/       oidc  session
```

Concretely: `routes/template.ts`, `routes/approvals.ts` and `routes/ledger.ts`
were created rather than growing `admin.ts`, and template definition moved out of
`admin.ts` into `routes/template.ts`.

**The client is organised the same way, and was not.** `components/views.tsx`
held seven unrelated screens — consolidation, consumption, variance, audit,
submissions, cost centres and governance — in 641 lines, while five other views
each had a file of their own. It is the same failure as `admin.ts` with a
blander name: `admin.ts` accepted anything an administrator could do, and
`views.tsx` accepted anything that was a view.

It had a second cost the server-side version did not. Views are lazily imported
for code splitting, and the unit of a chunk is a *file*: those seven shipped as
one 17 kB bundle, so a budget owner who only ever opens the grid downloaded the
governance, audit and cost-centre screens. Splitting them produced seven chunks
of 1.8–3.4 kB and made the evaluation's "per-view chunks a role may never
fetch" true rather than aspirational.

`reports.tsx` keeps its three views deliberately. They share the `useReport`
hook, they are one navigation group, and a caller who can reach one can reach
all three — the name describes the contents rather than admitting anything.

## Revision: `admin.ts` is gone

This ADR predicted the failure mode and then let it happen anyway. Having said
that a file called "the rest" is the thing to avoid, the next round of work put
drivers, allocations, governance, data-subject requests, retention, backups,
archive verification and the self-test into `admin.ts` — 712 lines and four
unrelated domains, held together by nothing but the fact that an administrator
performs all of them. "Administrator" is a role, not a domain, and a module
named after a role will accept anything that role can do.

It is now four modules, each one domain, each under 240 lines:

| Module | Domain |
|---|---|
| `routes/reference.ts` | Cost centres, entities, FX rates — the fixed points a line is written against |
| `routes/drivers.ts` | Drivers, driver trees, allocation pools — the quantities a budget is computed *from* |
| `routes/governance.ts` | Classifications, retention, data-subject rights, chain verification |
| `routes/operations.ts` | Backup, archive verification, the runtime self-test |

The test that this is a real boundary rather than four smaller piles: each one
can be described in a sentence that does not contain the word "and also". The
split moved no logic — the endpoints, their capabilities and their audit events
are unchanged, and the 575-test suite passed before and after without an edit.

## Why not full feature slices

The obvious alternative was `src/features/template/{routes,service,queries}.ts`
and so on, which is what ADR 0001 gestured at. It was rejected for a specific
reason rather than inertia.

**The security-relevant code must stay in one place.** `http/guard.ts`,
`db/pool.ts` and `services/audit.ts` are the three files that hold, respectively,
the authorisation gate, the SQL construction boundary and the audit write path.
Their value comes from there being exactly one of each. A feature-sliced layout
invites a `features/ledger/queries.ts` that builds its own SQL and a
`features/approvals/authz.ts` that makes its own judgement — and the moment a
second one of those exists, "review these three files" stops being sufficient and
nobody notices until it matters.

Splitting *routes* by domain gets the readability benefit — a file whose name says
what is in it — without splitting the parts where duplication is the risk. The
`onRoute` guard hook still refuses any route in any module that lacks a security
declaration, so a new domain module cannot accidentally opt out.

## Consequences

**Good.** Each route module is one subject and one requirement range. The
FR-051 gating logic sits in `services/approval.ts` as a pure function, so it is
unit-tested without a request — that split is the reason `outcomeOf` has six
direct tests covering rejection precedence and threshold skipping.

**Cost.** Two conventions now coexist, and "where does this go" has a
two-part answer instead of one. The rule: *a route module is a domain; a service
is a capability several domains may need.* `services/depreciation.ts` is a
service because the flow-through is invoked from the cycle route and could be
invoked from a scheduled job; `routes/ledger.ts` is a domain module because
nothing else ingests a ledger batch.

**Unchanged.** `tools/` stays outside `packages/` (the confidential-data gate
needs no exception), `db/` stays outside `packages/api` (the directory boundary
mirrors the privilege boundary), and `packages/shared` stays pure with no I/O so
the permission matrix and `Money` remain directly testable.

**Next threshold.** If a single route module needs its own persistence
vocabulary — its own query builders, its own row types used nowhere else — that
is the signal for a real feature slice for *that* module alone. Not before, and
not all at once.

# ADR 0003 — §4 and §5 read together, least privilege wins

**Status:** Accepted · **Drivers:** SPEC §4, §5, `SEC-001`, `SEC-010`

## Context

SPEC §4 gives CIO, CTO and Global Infrastructure a scope of "all technology
budgets, all entities". SPEC §5's matrix gives the same roles ✓ on "edit own
entity's lines" and — on "edit another entity's lines".

Read one way those conflict. Read another, §4 describes visibility and §5
describes authority.

## Decision

§5 is labelled **normative**, so it governs. Those roles **read** across all
entities and **write** only to entities they own. Capability and entity scope
are modelled as two separate axes: holding a capability is necessary but not
sufficient; the target entity must also be in scope.

Where the two readings differ, the more restrictive one is implemented.

## Why

Least privilege is the tie-breaker for an ambiguous specification, and the
matrix is the artefact the spec marks as authoritative. If the intent really is
group-wide write access for those three roles, that is a one-line change to
`PERMISSION_MATRIX` plus a §5 amendment in the same commit — which SPEC §0
already requires ("never widen a role's permissions without changing §5 in the
same commit").

## Consequences

- `budget.line.edit.any` is held by Admin alone.
- The read/write scope split is explicit in `readScope()` / `writeScope()`.
- `test/authz.test.ts` probes the two axes separately so a failure says which
  one refused.

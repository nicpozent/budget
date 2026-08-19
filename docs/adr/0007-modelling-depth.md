# ADR 0007 — Versions, driver trees, and no formula engine

**Status:** Accepted · **Drivers:** `FR-020`, `FR-021`, `FR-080`, `SEC-020`,
`SEC-022`, `INV-3`, `INV-4`, SPEC §11

## Context

The application evaluation scored modelling depth two stars out of five, and
named four things behind that score: no scenarios or versions in use, no rolling
forecast, no driver trees, and no formula engine. SPEC §11 had deferred versions
and scenarios out of v1 on purpose, asking only that the schema not preclude
them.

The product owner asked for the row to be closed. This records what was built,
and the one item that was not.

## Decision

**Versions, scenarios and a rolling forecast are built** (migration 008,
`services/versions.ts`). `budget_version` stopped being a free-text column and
became a table with a key, a kind, a lock and a foreign key from every amount.

**Driver trees are built** (`services/drivers.ts`, migration 010). A driver may
be defined as a sum of terms over other drivers for the same entity and year —
`devices = 1.5 per head + 2 per site`. A term is a row, `{ source, factor }`, so
addition and multiplication by a constant are structure rather than syntax and
nothing is parsed.

**A free-text formula engine is not built, and is not a gap to close later.**

## Why a formula engine is the wrong feature here

It is the item on the list that sounds most like the others and is least like
them.

A formula engine means a user-authored expression, stored as text, evaluated
against data at read time. Four things follow from that, and each one undoes
something this system currently guarantees.

**It is a code-injection surface by construction.** `SEC-020` and `SEC-022` are
built on the rule that nothing user-supplied is ever interpreted — values are
bound, identifiers come from an allow-list, and there is an ESLint rule blocking
the alternatives. A formula engine's entire purpose is to interpret user input.
Every mitigation for it — sandboxing, a hand-written parser, a restricted
grammar — is a *defence* against a class of problem that is currently *absent*.
The same reasoning is why `validation_rules` are named queries with a code
rather than expressions: the rule is chosen from a list, not written.

**It moves the definition of a number out of the code and out of review.** INV-4
holds because there is exactly one fold and the tests compare its two
implementations over the whole dataset. A formula is a second definition of what
a number is, authored by whoever has the screen open, with no review, no test
and no diff. The evaluation's own top finding — that an earlier prototype
derived parent figures independently and the numbers stopped reconciling — is
this failure mode with a nicer interface.

**It breaks the audit story.** `FR-070` records what changed and who changed it.
With a formula engine the audited event is "someone edited a formula", and the
figures that moved as a result are inferable at best. FR-021 asks for a driver
change to be recorded with its blast radius; `recomputeDriverTree` can state
that because the derivation is a multiplication the code knows about.

**Nobody has asked for one.** There is no requirement in `SPEC.md` for it. It
appears in the evaluation as a *comparison to best-of-breed planning tools*, and
that comparison is the answer: those tools are calculation engines with a system
of record attached, and Spendifre is a governed system of record. Adding an
expression language would make it a worse example of both.

If a specific calculation is genuinely needed, the route that stays inside the
guarantees is to add it as a named driver definition or a named validation rule
— code, reviewed, tested, and available to everyone rather than to the one
person who wrote the formula.

## Why the derived driver value is stored, not computed

`drivers.value` still holds a plain integer. The tree is resolved on write and
the result is materialised.

The alternative — resolving at read time — would put a recursive CTE inside the
reporting fold, which is the path NFR-001 was just spent getting under budget,
and would make a driver's value depend on which code path asked for it. Storing
it keeps the grid, the SQL fold and the allocation report untouched, and it is
the pattern FR-033 already uses for depreciation flow-through.

The cost of materialising is that the stored figure can go stale. That cost is
paid for explicitly: the runtime self-test re-derives every derived driver
against its parent and its factor, so a tree that stopped agreeing with its own
definition is a failing check rather than a wrong budget.

## Why acyclicity is enforced in the service

A CHECK constraint can refuse `devices` derived from `devices`, and migration
008 does. It cannot refuse `headcount → sites → devices → headcount`. A trigger
running a recursive CTE could, at the cost of a query on every driver write and
a rule stated in two languages.

The resolver detects cycles, every write runs it inside the transaction before
committing, and a cycle rolls the whole write back — asserted by a test that
checks the tree is unchanged afterwards. Combined with the self-test's
re-derivation, a cycle cannot be introduced through the API and could not
survive undetected if it were introduced another way.

## Why a version is group-wide

A scenario exists for the whole fiscal year, not per entity. A scenario that
covered some entities and not others would make a consolidation mean different
things in different rows: INV-4 would hold arithmetically while the total
answered no question anyone had asked.

That is also why `version.manage` is held by the Administrator and the CFO and
not by the entity managers. A manager creating a group-wide scenario over
everyone else's budget is not a permission anyone asked for.

## Why the sum is rounded once

A derived count is a count, so the result rounds. Rounding *each term* and then
adding would accumulate up to half a unit of error per term: three terms of 0.5
would give 3 where the arithmetic gives 1.5, which rounds to 2. The figure a
finance manager computes by hand is the one the tool has to agree with, so the
terms are summed at full precision and the total is rounded once, half away from
zero, matching `Money`. The self-test repeats that arithmetic in SQL rather than
trusting it.

## What this does not do

The scenarios screen is read-only about figures. Editing is the budget grid's
job and the grid works on the working plan. A second editable grid behind a
version selector would be two places to type the same number, and one of them
would be wrong.

Driver-linked lines are computed from their driver in every version (INV-3), so
a scenario that changes headcount changes the driver rather than the line. This
is stated on the screen rather than left to be discovered, because it is the one
place where "copy the plan and adjust it" does not behave the way the phrase
suggests.

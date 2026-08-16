# Spendifre — User Stories

User stories for every capability in Spendifre, organised by **module** and
tagged by **role**. Format:

> **US-\<module\>-\<n\>** — _As a **role**, I want **capability**, so that **benefit**._
> **Acceptance:** the conditions that make the story done.
> **Traces:** the `SPEC.md` requirement(s) it satisfies.

Each story's acceptance criteria are written so they can be checked, and most
are already checked — see the test suite named in the criterion. Stories marked
**DEFERRED** are recorded deliberately and not built; see `SPEC.md` §11.

### Roles

Nine server-authoritative roles, from Entra group membership (`SPEC.md` §4).
There is no role switcher — the prototype's persona dropdown was a demo
affordance.

| Role | Shorthand used below |
|---|---|
| Administrator (Group IT Finance) | **Admin** |
| CFO | **CFO** |
| Finance Manager | **FinMgr** |
| CIO · CTO · Global Infrastructure | **TechExec** |
| Security · Architecture · PMO Manager | **UnitMgr** |

**Budget owner** means any of FinMgr, TechExec or UnitMgr acting on an entity
they own. The CFO holds **no** editing capability at all.

---

## 1. Access & Identity

**US-ACC-1** — _As **any user**, I want to sign in with my Birgma account, so
that I do not manage another password._
**Acceptance:** OIDC authorisation code flow with PKCE S256 against Entra ID;
`state`, `nonce` and the code verifier held server-side and consumed on read, so
a replayed callback fails; no local account exists and there is no password
reset path.
**Traces:** `ZT-002`, §4

**US-ACC-2** — _As **Security**, I want role to come only from directory groups,
so that access is governed where joiners and leavers are already governed._
**Acceptance:** `SG-Spendifre-*` group claims map to exactly one role; role is
refreshed at every sign-in so a group removal takes effect at next login; a
principal in several role groups receives the **least** privileged
(`mapGroupsToRole`, unit-tested).
**Traces:** `ZT-004`, §4

**US-ACC-3** — _As **Security**, I want privileged roles to require a compliant
device and phishing-resistant MFA, so that a stolen password is not enough._
**Acceptance:** Conditional Access enforces it; the application **re-checks**
`amr` and device compliance on every request for Admin, CFO and FinMgr and
treats a session lacking either as unauthenticated, so a policy gap fails closed.
**Traces:** `ZT-002`, `ZT-003`

**US-ACC-4** — _As **Security**, I want irreversible actions to require fresh
authentication, so that an unattended session cannot approve a budget._
**Acceptance:** `submission.decide`, `cycle.phase`, `cycle.exception`,
`governance.edit`, `entity.manage`, `backup.run` and `backup.download` compare
against the session's `auth_time`, not its age; a stale session receives 401
`step_up_required`, distinguishable so the client can prompt.
**Traces:** `ZT-007`

**US-ACC-5** — _As **Security**, I want sessions revocable, so that a risk signal
ends access immediately._
**Acceptance:** `revokeAllForUser` ends every session for a principal; only
`sha256(token)` is stored, so a database read yields nothing usable; cookies are
`HttpOnly`, `Secure`, `SameSite=Lax`, host-prefixed; no token in `localStorage`.
**Traces:** `SEC-034`, `ZT-006`, `ZT-007`

**US-ACC-6** — _As **any user**, I want to be told plainly when I lack
permission, so that I do not think the system is broken._
**Acceptance:** 403 with a single safe message for a capability refusal; 404 for
an out-of-scope **read** so identifiers cannot be enumerated; no stack trace,
SQL text or submitted value ever appears in a response.
**Traces:** `SEC-011`

---

## 2. Budget entry

**US-ENT-1** — _As a **budget owner**, I want to see my entity's lines grouped by
category with live totals, so that I can work the way the workbook worked._
**Acceptance:** one round trip returns lines, periods, actuals, category totals
and the entity total; a 500-line grid renders under 1s and stays responsive
while typing.
**Traces:** `FR-010`, `NFR-001`

**US-ENT-2** — _As a **budget owner**, I want to edit each period inline, so that
entry is as fast as a spreadsheet._
**Acceptance:** typing into a quarter and leaving the field saves it; a stale
version returns 409 with a reload-and-retry message rather than overwriting
someone else's edit.
**Traces:** `FR-010`, `NFR-005`

**US-ENT-3** — _As a **budget owner**, I want to add and remove lines within a
category._
**Acceptance:** create and delete are audited; deletion is soft so history and
audit targets survive.
**Traces:** `FR-011`

**US-ENT-4** — _As **Finance**, I want a row never to mix currencies, so that a
column is always comparable._
**Acceptance:** every money column in a row renders in the **currently selected
unit**; the line's currency code is shown; a value typed in EUR is converted back
to the line's local currency **before storage**; storage is always local.
**Traces:** `FR-014`

**US-ENT-5** — _As **Finance**, I want restating an FX rate to restate every
derived figure, so that history does not need rewriting._
**Acceptance:** amounts are stored in local currency and converted at read time
from the FY-locked rate; a test proves that doubling a rate roughly doubles the
EUR total while **no stored amount moves**.
**Traces:** `NFR-003`, `FR-014`

**US-ENT-6** — _As a **budget owner**, I want to see which lines are incomplete,
so that I know what is left before submitting._
**Acceptance:** a completeness indicator over required fields; validation
warnings and blocking errors shown above the grid with the affected line count.
**Traces:** `FR-016`, `FR-057`

**US-ENT-7** — _As **Finance**, I want lines above the approval threshold
flagged._
**Acceptance:** any line whose EUR total exceeds the cycle threshold carries a
visible marker in the grid.
**Traces:** `FR-003`

**US-ENT-8** — _As **Finance**, I want the quarterly plan to always sum to the
annual figure._
**Acceptance:** property-tested for every line returned by the API, including
driver-computed lines where the final period absorbs the rounding remainder.
**Traces:** `INV-1`

---

## 3. Line detail, drivers & headcount

**US-LIN-1** — _As a **budget owner**, I want a side panel with **every** template
field, including ones hidden from the grid, plus phasing, justification and the
comment thread._
**Acceptance:** the drawer opens beside the grid, is keyboard reachable, closes
on `Escape` and returns focus.
**Traces:** `FR-012`, `A11Y-001`

**US-LIN-2** — _As a **budget owner**, I want to link a line to a volume driver,
so that it recalculates when the driver changes._
**Acceptance:** amount becomes `driverValue × rate`, the quarter inputs go
read-only, and the grid shows the expression. A direct write to a driver-linked
amount is refused with 403.
**Traces:** `FR-020`, `FR-021`, `INV-3`

**US-LIN-3** — _As **Finance**, I want turning headcount planning off to make
headcount-linked lines dormant, not deleted._
**Acceptance:** with planning off the line reverts to its stored manual value and
is marked dormant; no data is removed and the change is reversible.
**Traces:** `FR-022`, `INV-3`

**US-LIN-4** — _As a **budget owner**, I want a comment thread on a line, so that
the reasoning survives the cycle._
**Acceptance:** comments are stored verbatim and rendered as inert text —
markup round-trips intact and never executes; they are purged at 36 months.
**Traces:** `FR-012`, `SEC-030`, `SEC-031`

**US-LIN-5** — _As a **budget owner**, I want cost centre to be a constrained
choice over approved centres only._
**Acceptance:** the picker lists approved centres; booking to a pending or
rejected centre is refused server-side; a line already booked to one **keeps
showing it, flagged**, rather than being silently cleared.
**Traces:** `FR-013`, `INV-2`

---

## 4. Bulk operations

**US-BLK-1** — _As a **budget owner**, I want to select many lines and apply an
uplift, copy prior year, reassign a cost centre, or delete._
**Acceptance:** each operation is applied in one transaction; uplift goes through
`Money` rather than a SQL multiply, so rounding matches everywhere else.
**Traces:** `FR-015`

**US-BLK-2** — _As **Audit**, I want one audit event per bulk operation carrying
the affected count._
**Acceptance:** exactly one event, with the operation and the number of lines.
**Traces:** `FR-015`, `FR-070`

**US-BLK-3** — _As **Security**, I want every line in a bulk request
re-authorised individually._
**Acceptance:** a line belonging to another entity cannot be smuggled into the
list; every distinct entity is scope-checked and editability-checked; the
endpoint is rate limited to 20/min.
**Traces:** `SEC-011`, `SEC-013`

---

## 5. Actuals & consumption

**US-ACT-1** — _As a **budget owner**, I want to record spend per line per elapsed
period._
**Acceptance:** only elapsed periods are editable, decided from the **server**
clock; each entry is audited.
**Traces:** `FR-041`

**US-ACT-2** — _As a **budget owner**, I want to see plan, spend to date, YTD plan,
variance and consumed %, and to have lines burning faster than time flagged._
**Acceptance:** a line is over pace when `actual > plan × elapsed / periods`; a
zero plan with any spend is over pace by definition.
**Traces:** `FR-042`

**US-ACT-3** — _As **Finance**, I want consumption rolled up to category, entity
and group._
**Acceptance:** every rollup is a fold over the same line totals; no stored
parent exists to drift.
**Traces:** `FR-043`, `INV-4`

**US-ACT-4** — _As a **manager with several budgets**, I want to filter
consumption by entity, and to not see a filter row at all when I have only one._
**Acceptance:** filtering may only narrow what scope already permits — it can
never widen it.
**Traces:** `FR-044`

**US-ACT-5** — _As **Finance**, I want ledger-sourced periods protected from hand
editing._
**Acceptance:** `actuals.source` distinguishes `manual` from `ledger`; a
ledger-owned period refuses a manual write, because the next nightly refresh
would silently overwrite it.
**Traces:** `FR-040`

**US-ACT-6** — _As **Finance**, I want actuals ingested from the ledger nightly._
**NOT BUILT.** The seam exists (`actuals.source`); the feed does not. Largest
functional gap.
**Traces:** `FR-040`

---

## 6. Submission & approval

**US-SUB-1** — _As a **budget owner**, I want to submit my budget for review._
**Acceptance:** a **blocking** validation rule prevents submission server-side,
not merely in the UI; warnings are returned with the successful response.
**Traces:** `FR-050`, `FR-057`

**US-SUB-2** — _As the **CFO**, I want one card per submission with flags and
decision actions._
**Acceptance:** each card shows the entity, submitter, timestamp, state and the
count of lines approved and rejected.
**Traces:** `FR-052`

**US-SUB-3** — _As the **CFO**, I want to approve, reject, or request more
information as free text that returns to the owner._
**Acceptance:** the comment is stored, shown to the owner and written into the
audit detail; approve sets the entity to `approved`, request-info to
`changes_requested`, reject back to `draft`.
**Traces:** `FR-052`

**US-SUB-4** — _As the **CFO**, I want to decide individual lines, and to approve
them all at once._
**Acceptance:** per-line approve / reject / more-info with an optional free-text
question; approve-all is a single audited action carrying the count.
**Traces:** `FR-053`

**US-SUB-5** — _As **Internal control**, I want the actor who submits never to be
the actor who approves._
**Acceptance:** enforced by `CHECK` constraints in the database — not only in the
handler — for both submissions and cost centres, and tested at the database
level.
**Traces:** `SEC-012`, `CMP-150`

**US-SUB-6** — _As **Finance**, I want an approved budget to be immutable._
**Acceptance:** editing an approved or locked entity is refused; reopening
requires a CFO or FinMgr exception, which is itself audited.
**Traces:** `INV-5`, `FR-056`

**US-SUB-7** — _As **Group IT Finance**, I want configurable approval stages with
role and threshold conditions._
**DEFERRED / NOT BUILT.** States and transitions exist; reorderable stages do not.
**Traces:** `FR-051`

---

## 7. Cost centres

**US-CC-1** — _As **Admin**, I want to create cost centres._
**Acceptance:** created `pending`; the code is pattern-matched, not free text,
because it reaches exports.
**Traces:** `FR-013`, `SEC-023`

**US-CC-2** — _As the **CFO**, I want to approve or reject cost centres._
**Acceptance:** the creator can never approve their own — `CHECK cost_centre_sod`
refuses it in the database and the handler returns a meaningful message first.
**Traces:** `SEC-012`, `FR-013`

**US-CC-3** — _As a **budget owner**, I want a stale reference surfaced, not
silently cleared._
**Acceptance:** a line booked to a centre later rejected keeps showing the code,
flagged in the danger colour with a non-colour cue.
**Traces:** `INV-2`, `A11Y-001`

---

## 8. Cycle, lock & validation rules

**US-CYC-1** — _As the **CFO** or **FinMgr**, I want to move the cycle phase
(collection → review → locked → reforecast)._
**Acceptance:** restricted to those two roles; step-up required; audited.
**Traces:** `FR-055`

**US-CYC-2** — _As the **CFO** or **FinMgr**, I want a lock date that closes
submission._
**Acceptance:** after the lock date, edits are refused; the check is server-side.
**Traces:** `FR-056`

**US-CYC-3** — _As the **CFO** or **FinMgr**, I want to grant a per-entity
late-edit exception._
**Acceptance:** the exception reopens editing for a bounded number of days and is
audited with its reason.
**Traces:** `FR-056`

**US-CYC-4** — _As the **CFO** or **FinMgr**, I want to toggle validation rules._
**Acceptance:** rules are a fixed, named set evaluated by named queries — never
user-authored expressions, which would be a code-injection surface. An unknown
rule code is reported as a warning rather than silently skipped.
**Traces:** `FR-057`

---

## 9. Capex & depreciation

**US-CAP-1** — _As **FinMgr**, I want to be the only role that approves an asset
life._
**Acceptance:** `capex.approveAssetLife` is held by FinMgr alone; every other
role receives 403 (asserted for all nine roles).
**Traces:** `FR-031`

**US-CAP-2** — _As **Finance**, I want capex lines to generate a straight-line
schedule over the approved life._
**Acceptance:** the final year absorbs the rounding remainder so the schedule
sums back to the capitalised amount exactly; per-year totals follow the entity
filter.
**Traces:** `FR-030`, `FR-032`

**US-CAP-3** — _As **Finance**, I want next year's depreciation to flow into that
year's opex plan._
**NOT BUILT.** The schedule is computed; the flow-through is not wired.
**Traces:** `FR-033`

---

## 10. Reporting

**US-REP-1** — _As **Admin** or the **CFO**, I want the group position: total,
submission status per entity, and the category split._
**Acceptance:** every figure is the sum of its children; two independent
partitions (by entity, by category) both add back to the group total.
**Traces:** `FR-060`, `INV-4`

**US-REP-2** — _As **Finance**, I want variance against the prior year with the
largest movements first._
**Acceptance:** sorted by absolute movement; **increases render in the danger
colour with an up arrow** — this is a cost tool, so growth is the unwanted
direction — and the arrow carries the meaning independently of the colour.
**Traces:** `FR-062`, `A11Y-001`

**US-REP-3** — _As **Finance**, I want a five-year trend, total or by category or
by line, with a category explodable into its lines._
**Acceptance:** every year is folded from line level, which is what makes the
breakdown reconcile. **Endpoint built and tested; no dedicated screen yet.**
**Traces:** `FR-061`, `INV-4`

**US-REP-4** — _As **Finance**, I want FX rate history per currency with EUR
impact and volatility.
**Acceptance:** five years per currency with drift. **Endpoint built and tested;
no dedicated screen yet.**
**Traces:** `FR-063`

**US-REP-5** — _As **Finance**, I want central pools charged to entities on a
driver key, with own / charged / total visible._
**Acceptance:** the charged portion is read-only to the receiving entity.
**Endpoint built and tested; no dedicated screen yet.**
**Traces:** `FR-023`, `INV-6`

**US-REP-6** — _As **Admin** or the **CFO**, I want to export the consolidation to
XLSX._
**Acceptance:** every text cell passes the formula-injection guard — a leading
`=`, `+`, `-`, `@`, tab or CR is prefixed so the value is preserved but inert;
served as an attachment with `nosniff` and a fixed filename; rate limited to
5 per 5 minutes and audited with the row and entity count.
**Traces:** `FR-064`, `SEC-023`, `SEC-033`, `ZT-008`

---

## 11. Template & categories

**US-TPL-1** — _As **Admin**, I want to define line-item fields: label, type,
required, visible, order._
**Acceptance:** changes apply to all entities in the cycle; audited.
**Traces:** `FR-001`

**US-TPL-2** — _As **Admin**, I want to set the approval threshold._
**Traces:** `FR-003`

**US-TPL-3** — _As **Admin**, I want to manage cost categories._
**Traces:** `FR-004`

**US-TPL-4** — _As **Admin**, I want period granularity set once per cycle._
**Acceptance:** quarterly or monthly; the grid and every fold follow it.
**Traces:** `FR-002`

**US-TPL-5** — _As **Admin**, I want publishing a template version to be audited
and in-flight budgets to keep the version they started on._
**NOT BUILT.**
**Traces:** `FR-005`

**US-TPL-6** — _As **Admin**, I want to send in-app reminders to a target group
with a custom message and a sent log._
**Traces:** `FR-054`

---

## 12. Entities, owners & FX

**US-ORG-1** — _As **Admin**, I want to create and remove entities and assign
owners._
**Acceptance:** step-up required; audited; the owner is named by email and must
already be a known user.
**Traces:** `FR-014`, §5

**US-ORG-2** — _As **Admin**, I want to maintain FX rates._
**Acceptance:** rates accept **8 decimal places**, because VND (0.0000363), LAK
and KRW round to nothing at four; a zero or malformed rate returns 422, never a
500; the change records old → new.
**Traces:** `FR-014`, `NFR-003`

**US-ORG-3** — _As **Legal**, I want each entity bound to a residency region._
**Acceptance:** a deployment serves only its own region — an EU deployment
returns 404 for a mainland-China entity **even to an administrator** — and the
filter lives in the one resolver every read path calls.
**Traces:** `CMP-140`, §9.4

---

## 13. Audit trail

**US-AUD-1** — _As **Internal control**, I want every state-changing action
recorded with timestamp, actor, role, action, target, detail and kind._
**Acceptance:** append-only; the audit insert shares the handler's transaction,
so a failed audit rolls the business change back.
**Traces:** `FR-070`

**US-AUD-2** — _As a **manager**, I want to see my own audit entries; as **Admin**
or the **CFO**, all of them._
**Acceptance:** scoping is applied **in the query**, never hidden in the UI — a
manager's request never loads another actor's rows.
**Traces:** `FR-071`

**US-AUD-3** — _As **Audit**, I want to filter by kind and search full text._
**Acceptance:** search is parameterised through `plainto_tsquery`, so the user's
text is never interpreted as query syntax.
**Traces:** `FR-072`, `SEC-020`

**US-AUD-4** — _As **Internal control**, I want audit entries never editable or
deletable, by anyone._
**Acceptance:** three controls — revoked grants, a trigger that refuses `UPDATE`
unconditionally, and a SHA-256 hash chain. Deletion is possible only from the
retention function, only past retention, and it re-anchors the chain.
**Traces:** `FR-073`, `PRIV-001`

**US-AUD-5** — _As **Security**, I want tampering performed out of band to be
detectable._
**Acceptance:** `audit_verify_chain()` returns the sequence of the first altered
row. A test disables the trigger, edits a row, and asserts the exact sequence is
named — the compromised-DBA and doctored-restore case.
**Traces:** `CMP-103`

---

## 14. Data governance

**US-GOV-1** — _As **Admin** or the **CFO**, I want every field to carry exactly
one classification._
**Traces:** §9.1, `PRIV-002`

**US-GOV-2** — _As **Admin** or the **CFO**, I want configurable retention
enforced by a job, not by a policy document._
**Acceptance:** the job writes an audit event per run including the count purged.
**Traces:** `PRIV-001`

**US-GOV-3** — _As a **data subject**, I want my data exported on request._
**Acceptance:** returns the person's own records — user row, their comments,
their audit entries — and deliberately **not** the budget figures they touched,
which are commercial data belonging to the group.
**Traces:** `PRIV-003`, `CMP-133`

**US-GOV-4** — _As a **departed employee**, I want to be erased without breaking
the statutory record._
**Acceptance:** email, name and Entra id replaced, account deactivated, sessions
revoked, free text deleted — and the audit events **survive, still hash-link,
and still prove who approved what** while no longer identifying a person.
**Traces:** `PRIV-003`, `CMP-133`, `CMP-151`

**US-GOV-5** — _As **Admin** or the **CFO**, I want to verify the audit chain on
demand._
**Traces:** `CMP-103`, `ZT-008`

---

## 15. Operations

**US-OPS-1** — _As **Admin**, I want to trigger a backup._
**Acceptance:** every table except live sessions; AES-256-GCM with the key from
the environment; the manifest records row counts, a SHA-256 of the ciphertext,
and whether the audit chain verified at capture time. Without a key the API
**refuses** rather than writing plaintext. Step-up, 3 per 10 minutes, audited.
**Traces:** ADR-0005, `ZT-006`, `ZT-007`, `ZT-008`

**US-OPS-2** — _As **Admin**, I want to download a backup._
**Acceptance:** integrity checked twice (SHA-256, then the GCM tag) before any
byte is returned; a backup from another region is refused; the download is
audited separately from the creation.
**Traces:** ADR-0005, `CMP-140`

**US-OPS-3** — _As **Admin**, I want to see backup history with its integrity
state._
**Traces:** ADR-0005

**US-OPS-4** — _As **Admin**, I want to restore from a backup._
**NOT BUILT — deliberately.** An untested restore path invites false confidence.
**Traces:** `CMP-107`, `NFR-006`

**US-OPS-5** — _As **Platform**, I want a deployment to be able to seed from an
anonymised copy of real structure._
**Acceptance:** `SEED_MODE=synthetic|anonymised`; the anonymiser runs offline,
discards names and free text, jitters and rounds amounts, shuffles order, and
**reports which entities remain structurally unique**; production refuses any
mode but synthetic.
**Traces:** `PRIV-010`, `CMP-104`, ADR-0005

---

## 16. Platform & accessibility

**US-PLT-1** — _As a **keyboard or screen-reader user**, I want to operate the
whole grid._
**Acceptance:** real table semantics with `<caption>`, column and row-group
scopes, a hidden label per amount input, a skip link, visible focus everywhere,
and `tabindex` on scroll containers so they can be scrolled at all.
**Traces:** `A11Y-001`

**US-PLT-2** — _As a **user with a colour vision deficiency**, I want status never
conveyed by colour alone._
**Acceptance:** every status chip carries a glyph and every delta an arrow; axe
runs against the running app across eight views and no violation may merge.
**Traces:** `A11Y-001`, `A11Y-002`

**US-PLT-3** — _As **Finance**, I want money never to lose precision._
**Acceptance:** fixed-precision decimal end to end; no float arithmetic on
amounts anywhere; `NaN`, `Infinity` and exponent notation rejected at the
boundary; `parseFloat` banned by lint.
**Traces:** `NFR-002`, `SEC-022`

**US-PLT-4** — _As **Security**, I want an endpoint without an authorisation
decision to be impossible._
**Acceptance:** a route registered without a security declaration **throws at
registration**, so the server does not start.
**Traces:** `SEC-010`

**US-PLT-5** — _As a **user in Sweden, Switzerland or APAC**, I want dates and
numbers formatted for my locale._
**Acceptance:** `Intl` formatting from the browser locale; the value is never
reconstructed from formatted text. **Strings are not externalised** — partial.
**Traces:** `NFR-010`

---

## 17. Deliberately deferred

Recorded so they are decisions rather than omissions (`SPEC.md` §11).

| Story | Note |
|---|---|
| **US-DEF-1** Versions and scenarios | Amounts are addressable by `(line, period, version)` from day one; v1 writes only `working`, so adding this is a migration, not a rewrite (`FR-080`) |
| **US-DEF-2** Rolling forecast | `reforecast` exists as a cycle phase with no behaviour behind it |
| **US-DEF-3** Approved-plan snapshots | Same version dimension |
| **US-DEF-4** Procurement / purchase-order integration | Out of scope for v1 |
| **US-DEF-5** Contract lifecycle management | Out of scope, though the source workbook keeps contract terms in free text |
| **US-DEF-6** Multi-year capital planning beyond depreciation | Out of scope |
| **US-DEF-7** AI-assisted forecasting | Out of scope; prior-year figures are currently modelled from a growth factor, which is a placeholder and not a forecast |

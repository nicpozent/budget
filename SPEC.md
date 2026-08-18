# Spendifre — Project Constitution & Specification

Spendifre is the Birgma / Biltema Group IT budget platform: admins define the budget template,
budget owners fill it in, the CFO signs it off, and the group consolidates it in EUR.

This file is the **single source of truth** for Claude Code. It follows Spec Driven Development:
nothing is built that is not written here as a numbered, testable requirement. If an
implementation and this document disagree, this document wins and the code is a defect.

---

## 0. How to work in this repository

**The loop.** `specify → plan → tasks → implement → verify`.

1. **Specify.** Every change starts as a requirement in §6–§10 with a stable ID
   (`FR-`, `SEC-`, `PRIV-`, `NFR-`, `A11Y-`) and at least one acceptance criterion written as
   *given / when / then*. No ID, no code.
2. **Plan.** Record the approach, the files it touches, and the migration in
   `docs/plans/<ID>-<slug>.md`. State what you are NOT doing.
3. **Tasks.** Break the plan into commits that each leave `main` green.
4. **Implement.** Write the failing test first, then the code. Reference the requirement ID in
   the commit message: `feat(FR-041): record actual spend per line`.
5. **Verify.** A requirement is done when its acceptance criteria are automated in the test
   suite, not when the screen looks right.

**Rules that do not bend.**

- Never widen a role's permissions without changing §5 in the same commit.
- Never add a field that holds personal data without classifying it in §9.
- Never write a query by string concatenation (see `SEC-020`).
- Never trust a value from the client for identity, role, entity scope, or money. Re-derive
  server-side from the session.
- Every state-changing action writes an audit event (`FR-070`). A handler without an audit call
  is an incomplete handler.
- Prefer deleting code to adding a flag.

**Definition of done.** Acceptance criteria automated · audit event emitted and asserted ·
authorisation test proving the wrong role gets 403 · no new `axe` violations · requirement ID in
the commit message.

---

## 1. Current state — read this before planning

What exists today is a **clickable prototype**, not an application:

| Path | What it is |
|---|---|
| `Budget Tool.dc.html` | The whole product as one component — all screens, all roles |
| `Budget Login.dc.html` | Entra ID sign-in flow (visual only, no real OIDC) |
| `budget-data.js` | Real FY2026 data extracted from the source workbook: 21 entities, ~480 line items, FX table |
| `docs/screenshots/` | 25 reference screenshots + `README.md` mapping each file to its screen |
| `assets/` | Birgma and Biltema logos |

**It has no backend, no authentication, no persistence, and no authorisation.** State lives in
component memory and dies on reload. The role switcher and manager-persona dropdown are demo
affordances — treat them as a specification of *which roles exist*, never as a security model.

**What the prototype does demonstrate**, screen by screen, is every requirement in §6 except
`FR-005`, `FR-033`, `FR-040`, `FR-051` (stages are editable but do not gate anything),
`FR-057` (rules toggle but do not block) and `FR-064`. The audit trail (`FR-070`–`FR-073`) and
data governance (§9) screens exist and are wired to real in-session events. Treat every screen as
a specification of intended behaviour, and every "it works" as UI-only until it has a server
behind it.

**Prior-year figures are modelled, not real.** Every line carries a `pyFactor`, and prior years
are derived by compounding it. Series are summed from the line level so that a parent always
equals the sum of its children. Replace with ledger data (`FR-040`); keep the summation
property, and keep it under test.

**The screenshots are the visual contract.** Build to them. Where this document and a screenshot
disagree, this document wins — note the discrepancy in the plan.

---

## 2. Target architecture

Nothing below is built yet. Choose deliberately; record the decision as an ADR in `docs/adr/`.

- **Frontend** — TypeScript, React, server-side rendering. Inline-style prototype markup is a
  visual reference, not the production styling approach.
- **API** — one service, REST or tRPC. All authorisation server-side.
- **Data** — PostgreSQL. Money as `numeric`, never float. Amounts stored in the line's local
  currency with the FX rate applied at read time, so a rate change restates history correctly.
- **Identity** — Microsoft Entra ID, OIDC authorisation code flow with PKCE. Roles from group
  claims. No local accounts, no password reset path.
- **Audit** — append-only table, no `UPDATE` or `DELETE` grant to the application role.
- **Hosting** — Azure. Region per §9.4; note that mainland China cannot share the EU tenant.

---

## 3. Domain model

```
Entity (21)            code, name, owner, currency, deadline, status
  └─ Category          name, capex|opex, ordered, admin-defined
       └─ LineItem     name, vendor, costCentre, glAccount, type, currency,
                       q1..q4 (plan), justification, attachments,
                       driverLink?  { driverId, ratePerUnit }
                       actuals      { q1..q4 recorded spend }
CostCentre             code, description, status: pending|approved|rejected
Driver                 name, unit, value          (headcount, sites, devices, stores)
AllocationPool         name, amount, driverKey    charged out to entities
FxRate                 currency, year, rate       FY-locked, admin-editable
Template               fields[], granularity, approvalThreshold
Cycle                  phase, lockDate, lockEnabled, exceptions[], validationRules[]
AuditEvent             ts, actor, role, action, target, detail, kind   (append-only)
```

**Invariants.**

- `INV-1` A line's quarterly plan sums to its annual total.
- `INV-2` A line may only reference an **approved** cost centre. Existing references to a
  rejected or pending centre are surfaced as exceptions, never silently cleared.
- `INV-3` A driver-linked line's amount is computed, never stored as an independent value.
- `INV-4` Any aggregate equals the sum of its children, in every year.
- `INV-5` An approved budget is immutable. Reopening requires a CFO or Finance Manager
  exception and writes an audit event.
- `INV-6` Allocation charges are read-only to the receiving entity.

---

## 4. Actors

| Actor | Entra group | Scope |
|---|---|---|
| Administrator (Group IT Finance) | `SG-Spendifre-Admin` | All entities. Template, entities, cost centres, FX, workflow, governance |
| CFO | `SG-Spendifre-CFO` | All entities. Approve, reject, request information, cost-centre validation, cycle, rules |
| Finance Manager | `SG-Spendifre-Mgr-Finance` | Own entity + approves capex asset lives + cycle co-owner |
| CIO | `SG-Spendifre-CIO` | All technology budgets, all entities |
| CTO | `SG-Spendifre-CTO` | All technology budgets, all entities |
| Global Infrastructure | `SG-Spendifre-Mgr-Infra` | All technology budgets, all entities |
| Security Manager | `SG-Spendifre-Mgr-Security` | Own entity only |
| Architecture Manager | `SG-Spendifre-Mgr-Arch` | Own entity only |
| PMO | `SG-Spendifre-Mgr-PMO` | Own entity only |

---

## 5. Permission matrix — normative

`✓` allowed · `—` denied · `R` read-only

| Capability | Admin | CFO | Finance Mgr | CIO / CTO / Infra | Other Mgr |
|---|---|---|---|---|---|
| Edit own entity's lines | ✓ | — | ✓ | ✓ | ✓ |
| Edit another entity's lines | ✓ | — | — | — | — |
| View another entity's budget | ✓ | ✓ | R | R | — |
| Submit a budget | — | — | ✓ | ✓ | ✓ |
| Approve / reject a submission | — | ✓ | — | — | — |
| Request more information | — | ✓ | — | — | — |
| Per-line approve / reject | — | ✓ | — | — | — |
| Define template fields | ✓ | — | — | — | — |
| Create cost centre | ✓ | — | — | — | — |
| Approve cost centre | — | ✓ | — | — | — |
| Create / remove entity | ✓ | — | — | — | — |
| Edit FX rates | ✓ | — | — | R | R |
| Approve capex asset life | — | — | ✓ | — | — |
| Move cycle phase / lock date | — | ✓ | ✓ | — | — |
| Grant late-edit exception | — | ✓ | ✓ | — | — |
| Toggle validation rules | — | ✓ | ✓ | — | — |
| Record actual spend | ✓ | — | ✓ | ✓ | ✓ |
| Edit allocation pools | ✓ | — | — | — | — |
| View full audit trail | ✓ | ✓ | — | — | — |
| View own audit entries | ✓ | ✓ | ✓ | ✓ | ✓ |
| Change classification / retention | ✓ | ✓ | — | — | — |

`SEC-001` Every capability above has a test asserting that each denied role receives `403`.
Authorisation is enforced in the API. UI hiding is presentation, never protection.

---

## 6. Functional requirements

### 6.1 Template (admin)
- `FR-001` Admin defines line-item fields: label, type (`text|select|money|note|file`),
  required, visible, order. Changes apply to all entities in the cycle.
- `FR-002` Period granularity is quarterly or monthly, set once per cycle.
- `FR-003` An approval threshold flags lines above a configurable EUR amount.
- `FR-004` Admin manages cost categories: rename, reorder, capex/opex, add, remove.
- `FR-005` Publishing a template version is an audited event; in-flight budgets keep the
  version they were started on.

### 6.2 Entry (budget owner)
- `FR-010` Edit every visible field and every period amount inline in a grid.
- `FR-011` Add and delete lines within a category.
- `FR-012` A side panel exposes **every** template field including ones hidden from the grid,
  plus phasing, justification and the comment thread.
- `FR-013` Cost centre is a constrained choice over approved centres only (`INV-2`).
  A stale reference renders as an exception.
- `FR-014` Currency per line; totals shown in local or EUR at the FY-locked rate. A single row
  never mixes units: every money column in a row renders in the currently selected unit, the
  line's currency code is displayed, and a value typed in EUR is converted back to the line's
  local currency before storage.
- `FR-015` Bulk operations over a multi-line selection: uplift by %, copy prior year,
  reassign cost centre, delete. One audit event per operation, with the affected count.
- `FR-016` Completeness indicator over required fields.

### 6.3 Drivers, headcount, allocations
- `FR-020` Volume drivers with editable values: headcount, sites, managed devices, stores.
- `FR-021` A line may be linked to a driver with a rate per unit; the amount becomes
  `driverValue × rate`, is read-only, and recalculates when the driver changes (`INV-3`).
- `FR-022` Headcount planning is a cycle-level toggle. When off, headcount-linked lines revert
  to manual and are shown as dormant, not deleted.
- `FR-023` Central pools are charged to entities on a driver key; own vs charged vs total is
  visible per entity and read-only to the receiver (`INV-6`).

### 6.4 Capex depreciation
- `FR-030` Capex lines generate a straight-line schedule over a configurable asset life.
- `FR-031` The Finance Manager approves or rejects each asset life; nobody else can.
- `FR-032` Entity filter, and per-year totals that follow the filter.
- `FR-033` Next year's depreciation flows into that year's opex plan.

### 6.5 Actuals and consumption
- `FR-040` Ingest actuals from the ledger, keyed to line and period, refreshed nightly.
  Until that exists, the recorded value in `FR-041` is the source.
- `FR-041` Budget owners record spend to date per line per elapsed period. Only elapsed
  periods are editable. Each entry is audited.
- `FR-042` Show per line: full-year plan, spend to date, YTD plan, variance %, consumed % —
  and flag lines consuming faster than time elapsed.
- `FR-043` Roll consumption up to category, entity and group.
- `FR-044` Consumption is filterable by **entity, budget and manager**, cascading: choosing an
  entity narrows the budget and manager lists to that entity; choosing a budget narrows the
  manager list to its owner. KPIs, the per-line table and the category rollup all follow the
  filter. The filter row is hidden when the caller has only one budget in scope. Filtering never
  widens scope — it may only narrow what `SEC-011` already permits.

### 6.6 Workflow
- `FR-050` States: draft → submitted → (changes requested) → approved → locked.
- `FR-051` Configurable stages with role and threshold conditions; reorderable, switchable.
- `FR-052` CFO approves, rejects, or requests information as **free text**, which returns the
  budget to the owner and is visible to them.
- `FR-053` Per-line approve / reject / more-info with a free-text question, plus approve-all.
- `FR-054` In-app reminders to a target group with a custom message and a sent log.
- `FR-055` Cycle phases: collection → review → locked → reforecast. CFO and Finance Manager only.
- `FR-056` A lock date closes submission; per-entity exceptions reopen it and are audited.
- `FR-057` Validation rules marked blocking or warning. A blocking rule prevents submission
  server-side, not merely in the UI.

### 6.7 Reporting
- `FR-060` Consolidation: group total, submission status per entity, category split.
- `FR-061` Five-year trend with entity filter; total, by category, or top lines; a breakdown
  that explodes a category into its lines, any of which can be plotted (`INV-4`).
- `FR-062` Variance 2026 vs prior with entity filter, largest movements by absolute value,
  and a two-sided diverging chart.
- `FR-063` FX rate history per currency with EUR impact and volatility.
- `FR-064` Export consolidated figures to XLSX.

### 6.8 Audit
- `FR-070` Every state-changing action writes: timestamp, actor, role, action, target, detail,
  kind (`change|approval|workflow|governance`). Append-only.
- `FR-071` Admin and CFO see all events. **Every other role sees only their own**, filtered in
  the query, never hidden in the UI.
- `FR-072` Filter by kind and full-text search.
- `FR-073` Audit entries are never editable or deletable, by anyone, including admins.

---

## 7. Security requirements

Baseline: **OWASP ASVS 5.0 Level 2**, and no finding in the **OWASP Top 10 (2021)** or
**OWASP API Security Top 10 (2023)** may ship. `SEC-`IDs below are the ones that need explicit
design attention; ASVS applies in full regardless of whether it is restated here.

### 7.1 Injection — OWASP A03
- `SEC-020` **SQL injection.** All database access goes through parameterised statements or the
  ORM's binding layer. String-concatenated or template-interpolated SQL is prohibited and
  blocked in CI by a lint rule and a review checklist item. Dynamic `ORDER BY`, `LIMIT`, table
  and column names come from an allow-list, never from request input — this is the one place
  parameterisation does not protect you.
- `SEC-021` The application database role holds least privilege: no DDL, no `DELETE` on the
  audit table, no superuser. Migrations run as a separate role.
- `SEC-022` Every request input is validated against a schema at the boundary (type, range,
  length, enum, currency code, ISO date) and rejected on failure. Validation is allow-list, not
  deny-list. Amounts are parsed to a fixed-precision decimal; `NaN`, `Infinity` and
  exponent notation are rejected.
- `SEC-023` No user input reaches a shell, file path, LDAP filter, or spreadsheet formula.
  **CSV/XLSX export escapes leading `=`, `+`, `-`, `@`, tab and CR** to prevent formula
  injection in the recipient's Excel — this product exports finance data, so it is in scope.

### 7.2 Cross-site scripting — OWASP A03
- `SEC-030` **Output encoding by default.** Render through a framework that context-escapes.
  React's `dangerouslySetInnerHTML` and any equivalent are prohibited; if a rich-text field is
  ever introduced, it must be sanitised server-side with a maintained allow-list sanitiser and
  re-sanitised on read.
- `SEC-031` This product stores attacker-influenced free text — justifications, comment threads,
  CFO information requests, cost-centre descriptions, entity and field names, reminder
  messages. Each is a **stored XSS** vector and must be covered by a test that submits a
  payload (`<img src=x onerror=...>`, `"><script>`, `javascript:` URL, unicode and
  double-encoded variants) and asserts it renders as inert text.
- `SEC-032` A strict **Content Security Policy**: no `unsafe-inline`, no `unsafe-eval`,
  nonce-based scripts, `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`, and a report endpoint. Note the prototype's inline styles will not
  survive this — plan the styling approach accordingly.
- `SEC-033` Security headers: `Strict-Transport-Security` with preload,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` denying unused features. Uploads are served from a separate origin with
  `Content-Disposition: attachment` and a fixed content type.
- `SEC-034` Session cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, host-prefixed. No token
  in `localStorage`. Anti-CSRF on every state-changing request (double-submit or origin check
  in addition to `SameSite`).
- `SEC-035` No URL, redirect target, or file name from input is reflected without validation
  against an allow-list; open redirects are a build failure.

### 7.3 Access control — OWASP A01
- `SEC-010` Deny by default. Every endpoint declares its required role and entity scope; the
  absence of a declaration fails the build.
- `SEC-011` Object-level authorisation on every read and write: prove the caller may see *this*
  entity, *this* line, *this* audit entry. IDs are opaque UUIDs, and enumerating another
  entity's ID returns `404`, not `403`, on read paths.
- `SEC-012` Segregation of duties enforced in data, not UI: the actor who submits cannot be the
  actor who approves; the actor who creates a cost centre cannot approve it.
- `SEC-013` Rate limiting per user and per IP on authentication, export, and bulk operations.

### 7.4 Zero Trust
Aligned to **NIST SP 800-207** and the Microsoft Zero Trust pillars. Assume breach; the network
grants nothing.

- `ZT-001` **Verify explicitly.** Every request is authenticated and authorised on its own
  merits. No implicit trust from network position, VPN presence, or a prior request in the
  session.
- `ZT-002` **Identity is the perimeter.** Entra ID with Conditional Access; phishing-resistant
  MFA (number matching minimum, FIDO2 preferred) for CFO, Finance Manager and Administrator.
- `ZT-003` **Device signal.** Managed, compliant device required for privileged roles;
  compliance state is a Conditional Access condition, re-evaluated per session.
- `ZT-004` **Least privilege, just in time.** Standing admin rights are not granted.
  Privileged roles are activated through PIM with justification, approval and expiry.
- `ZT-005` **Micro-segmentation.** API, database and object storage are private-networked with
  no public ingress. Service-to-service auth uses workload identity, not shared secrets.
- `ZT-006` **Assume breach.** Encryption in transit (TLS 1.3) and at rest; secrets in Key
  Vault with rotation; no secret in source, image, or environment file.
- `ZT-007` **Continuous verification.** Session revocation on risk signal; short access-token
  lifetime; re-authentication before an irreversible action (approve, lock, purge).
- `ZT-008` **Full telemetry.** Auth, authorisation denials, data access and admin actions ship
  to the SIEM. Alert on privilege change, mass export, and audit-write failure.

### 7.5 Software supply chain — OWASP A06 / A08
- `SEC-040` Dependencies pinned with a lockfile; automated vulnerability alerts; an SBOM per
  release; builds are reproducible and artefacts signed.
- `SEC-041` SAST, dependency scanning, secret scanning and IaC scanning gate every PR.
  DAST against a staging deployment each release. Penetration test before go-live and annually.
- `SEC-042` Threat model maintained per epic (STRIDE), reviewed when a trust boundary moves.

---

## 8. Compliance backlog — open, none satisfied yet

The prototype satisfies none of the following. Each needs an owner and a target release.
Legal review is required; the notes below are engineering scope, not legal advice.

### 8.1 ISO/IEC 27001:2022 + 27002
- `CMP-101` Scope statement, risk assessment and treatment plan, Statement of Applicability.
- `CMP-102` A.5.15–5.18 access control: joiner/mover/leaver, quarterly access review,
  privileged access register.
- `CMP-103` A.8.15–8.16 logging and monitoring — partially met in design by `FR-070`; needs
  tamper evidence, clock sync, and retention enforcement.
- `CMP-104` A.8.25–8.31 secure development: SDLC policy, separated environments, no production
  personal data in test.
- `CMP-105` A.5.19–5.23 supplier and cloud service management, including Microsoft as processor.
- `CMP-106` A.5.24–5.28 incident management with defined severities and timelines.
- `CMP-107` A.8.13 backup, and A.5.29–5.30 continuity with a tested RTO/RPO.

### 8.2 NIST
- `CMP-110` Map controls to **NIST CSF 2.0** (Govern, Identify, Protect, Detect, Respond,
  Recover) and keep the mapping current — it is the common language for customer assurance.
- `CMP-111` **NIST SP 800-207** Zero Trust: implement §7.4 and record the maturity assessment.
- `CMP-112` Where SP 800-53 controls are contractually required, map them from the CSF profile
  rather than maintaining a second inventory.

### 8.3 NIS2 (EU) and Swiss reporting
- `CMP-120` Determine applicability. A retail group is unlikely to be an essential or important
  entity by sector alone, **but obligations commonly arrive contractually through the supply
  chain** — resolve this with Legal before assuming out of scope.
- `CMP-121` If in scope in Sweden: register with the competent authority, meet the
  Cybersäkerhetslagen risk-management measures, and implement 24h early warning / 72h
  incident notification.
- `CMP-122` Management-body accountability and cyber-security training obligations.
- `CMP-123` Switzerland is outside NIS2; assess the Swiss NCSC reporting duty separately.
- `CMP-124` Supply-chain security obligations flowed down to our own vendors.

### 8.4 GDPR (Sweden) and revFADP (Switzerland)
- `CMP-130` Record of processing activities. Personal data here: budget owners, approvers,
  comment authors, free-text mentions, audit actors, headcount figures where granular.
- `CMP-131` Lawful basis and an employee-facing privacy notice covering monitoring implied by
  the audit trail.
- `CMP-132` Data minimisation — challenge every free-text field; storage limitation enforced by
  the retention job in §9.
- `CMP-133` Data subject rights: access, rectification, erasure, restriction, portability, with
  an SLA. Erasure must not break the audit chain — pseudonymise the actor, retain the event.
- `CMP-134` DPIA, given cross-border scope, employee monitoring and profiling-adjacent
  headcount planning.
- `CMP-135` Processor agreements with Microsoft and every sub-processor; transfer mechanism
  (SCCs + transfer impact assessment) for non-EEA processing.
- `CMP-136` **revFADP is a separate regime, not GDPR.** Swiss register, Swiss privacy notice,
  Swiss transfer list, and a Swiss representative if required. GDPR compliance alone leaves gaps.
- `CMP-137` Breach notification: 72h to the IMY (Sweden); FDPIC (Switzerland) on its own terms.

### 8.5 APAC
- `CMP-140` **China PIPL** — the architectural blocker. Data localisation, separate consent,
  and a CAC transfer mechanism (standard contract, certification, or security assessment).
  **Decide before choosing hosting topology:** a single global tenant is likely not lawful, and
  the workbook contains CNY, HKD, TWD, VND, IDR, THB, MYR, PHP, INR, BDT, LKR, KRW and LAK.
- `CMP-141` **Singapore PDPA** — consent and notification obligations, data breach notification,
  a designated Data Protection Officer.
- `CMP-142` **Japan APPI** — purpose specification, cross-border transfer disclosure.
- `CMP-143` **India DPDPA 2023** — notice and consent, Data Principal rights, breach reporting;
  track the rules as they commence.
- `CMP-144` **Australia Privacy Act / APPs** — APP 8 cross-border disclosure accountability,
  notifiable data breaches.
- `CMP-145` **Hong Kong PDPO**, **South Korea PIPA**, **Taiwan PDPA**, **Indonesia PDP Law**,
  **Thailand PDPA**, **Vietnam PDPD**, **Philippines DPA**, **Sri Lanka PDPA**,
  **Bangladesh** (draft) — confirm which entities process personal data and triage.

### 8.6 Financial control
- `CMP-150` Internal control over financial reporting: segregation of duties (`SEC-012`),
  change management, and a complete audit trail (`FR-070`, `FR-073`).
- `CMP-151` Approval evidence retained and reproducible for the statutory period.
- `CMP-152` If the group is or becomes subject to SOX or an equivalent, add control testing
  and management attestation.

### 8.7 Accessibility
- `CMP-160` **WCAG 2.2 AA**, and **EN 301 549** for the European Accessibility Act and Swedish
  procurement. See §10 — the prototype fails this today and it is the cheapest gap to close.

---

## 9. Data classification and retention

### 9.1 Classes
`Public` · `Internal` · `Confidential` · `Personal data`. Every field carries exactly one.
Vendor names, contract values, justifications and attachments are at least `Confidential`.

### 9.2 Retention — configurable, enforced by a job, not by policy alone
| Data | Default | Basis |
|---|---|---|
| Audit trail | 84 months | ISO 27001 A.8.15 |
| Budget records and approved versions | 120 months | Statutory accounting |
| Comments, justifications, information requests | 36 months | GDPR Art. 5(1)(e) |
| Inactive user records | 24 months | GDPR / revFADP |

- `PRIV-001` A scheduled job enforces every period above and writes an audit event per run,
  including the count purged. Retention that is documented but not executed is a finding.
- `PRIV-002` Changing a classification or a retention period is restricted to Admin and CFO and
  is audited.
- `PRIV-003` Data subject actions are first-class features, not scripts: export one person's
  data; pseudonymise a departed user while keeping the audit chain intact; purge expired free
  text.

### 9.3 Test data
- `PRIV-010` No production personal data in non-production. Seed data is synthetic. The
  workbook figures in `budget-data.js` are real commercial data — treat them as `Confidential`
  and do not publish them outside the group.

### 9.4 Residency
| Region | Law | Hosting | Note |
|---|---|---|---|
| Sweden · EU | GDPR + Swedish DPA | Azure Sweden Central | Primary |
| Switzerland | revFADP | Azure Switzerland North | Separate regime |
| Singapore · APAC hub | PDPA | Azure Southeast Asia | SCCs for EU transfers |
| Mainland China | PIPL | In-country, not provisioned | Blocks a single global tenant |

---

## 10. Non-functional requirements

- `NFR-001` A 500-line budget grid renders in under 1s and stays responsive while typing.
  The prototype regressed here once by emitting ~5,700 `<option>` nodes; shared option sources
  fixed it. Keep a DOM-size budget under test.
- `NFR-002` Money is fixed-precision decimal end to end. No float arithmetic on amounts.
- `NFR-003` FX conversion happens at read time from the FY-locked rate, so restating a rate
  restates every derived figure consistently.
- `NFR-004` `INV-4` is covered by a property test: for every aggregate, in every year, parent
  equals the sum of its children.
- `NFR-005` Optimistic concurrency on line edits with a clear conflict message. Two owners must
  not silently overwrite each other.
- `NFR-006` Availability target 99.5% during the collection window; tested backups; documented
  RTO/RPO.
- `A11Y-001` WCAG 2.2 AA. The prototype fails today: body text at 9.5–11px, low-contrast grey
  on dark, and status conveyed by colour alone. Production minimum 14px body, 4.5:1 contrast
  for text and 3:1 for UI components, a non-colour cue beside every status colour, visible
  focus, full keyboard operation of the grid, and screen-reader labels on every icon control.
- `A11Y-002` `axe` in CI; no new violations may merge.
- `NFR-010` English is the source language. Externalise strings; format currency, number and
  date per locale. Sweden, Switzerland and APAC differ on separators and date order.

---

## 11. Out of scope for v1 — write it down, do not build it

Versions and scenarios, rolling forecast, and approved-plan snapshots are the largest remaining
functional gap and are **deliberately deferred**. When they arrive they add a *version
dimension* to every stored amount, so:

- `FR-080` (deferred) Do not design the schema in a way that makes a version dimension a
  rewrite. Amounts should be addressable by `(line, period, version)` from day one, even if v1
  only ever writes `version = 'working'`.

Also out of scope: procurement and purchase-order integration, contract lifecycle management,
multi-year capital planning beyond the depreciation schedule, and any AI-assisted forecasting.

---

## 12. Open decisions

1. **PIPL and cross-border transfer.** The *topology* is decided — one central deployment,
   not one per region — which removes the architectural half of this question and sharpens the
   legal half: a central deployment serving another jurisdiction's entities is a transfer, and
   needs a lawful basis. Still needs Legal, plus a decision on whether mainland China entities
   are in scope at all. Until then `SERVED_REGIONS` names only the jurisdictions that have one.
   (`CMP-140`)
2. **NIS2 applicability** — sector assessment plus supply-chain flow-down review. (`CMP-120`)
3. **Ledger integration** for actuals: which system, what granularity, what cadence. (`FR-040`)
4. **Entra group model** — one group per role, or role plus entity-scope groups.
5. **Whether the CFO may edit figures directly**, or only approve, reject and request changes.
   The prototype assumes the latter; §5 encodes that. Confirm with Finance.

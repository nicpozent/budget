# Statement of Work — Spendifre

> **How to use this document.** The scope, deliverables, acceptance criteria and
> security/compliance commitments below are grounded in the delivered system —
> where something is built, a test or a file is named; where it is not, it says
> so. Fields in **[brackets]** — parties, dates, effort and commercials — are for
> the contracting parties to complete; they are intentionally not pre-filled.

| | |
|---|---|
| **Project** | Spendifre — Birgma / Biltema Group IT budget platform |
| **Client / Sponsor** | [Birgma / Biltema — sponsor name] |
| **Supplier / Delivery** | [Delivery team / vendor] |
| **SoW version** | 1.0 · [date] |
| **Effective period** | [start] – [end] |
| **Document owner** | [name, role] |

---

## 1. Purpose

This Statement of Work defines the scope, deliverables, approach, acceptance
criteria and responsibilities for the design, build and hand-over of
**Spendifre** — the group IT budget platform. Group IT Finance defines the
budget template, budget owners across **21 entities** fill in their lines, the
CFO signs off line by line, and the group consolidates in EUR at a year-locked
FX rate. Identity is federated to **Microsoft Entra ID**; authorisation is
enforced server-side against a normative permission matrix.

The governing specification is `SPEC.md`, written for Spec Driven Development:
every behaviour is a numbered, testable requirement (`FR-`, `SEC-`, `ZT-`,
`PRIV-`, `NFR-`, `A11Y-`, `CMP-`). Where this SoW and `SPEC.md` disagree,
`SPEC.md` governs.

## 2. Background

The FY2026 IT budget runs on a 25-sheet Excel workbook
(`2026 IT budget consolidated FINAL.xlsx`) covering 21 entities, ~486 line items
and 8 currencies. The workbook has no access control, no audit trail, no
segregation of duties between preparer and approver, and no way to prevent a
figure being changed after approval. Consolidation is manual and FX is applied
inconsistently.

Spendifre replaces it with a role-aware platform: a governed entry grid,
server-enforced approval workflow, an append-only and tamper-evident audit
trail, fixed-precision money with read-time FX, and data governance sufficient
for GDPR, revFADP and ISO 27001 evidence.

## 3. Objectives

1. Federated SSO and least-privilege authorisation — 9 roles from Entra groups,
   enforced server-side, with an endpoint that lacks an authorisation decision
   being **impossible to register**.
2. A complete, accessible budget cycle: entry, drivers, actuals, capex,
   submission, per-line approval, consolidation and variance.
3. **Financial correctness that is provable**: fixed-precision money, read-time
   FX, and reconciliation (parent = sum of children) held by a property test.
4. **Non-repudiation**: every state change recorded in an append-only,
   hash-chained audit trail that detects tampering it cannot prevent.
5. **Governance by design**: field classification, retention enforced by a job,
   and data-subject rights as first-class features.
6. **Data residency** enforced in code, ready for whichever hosting topology
   Legal selects for `CMP-140`.
7. WCAG 2.2 AA, gated in CI against the running application.

## 4. Scope of work

### 4.1 In scope (work packages)

| WP | Work package | Content |
|---|---|---|
| **WP1** | Platform & security foundation | TypeScript monorepo; Fastify API; PostgreSQL 16 with three least-privilege roles; migration framework with checksum guards; strict CSP and full security-header set; CSRF, rate limiting, boundary validation; config that fails closed in production |
| **WP2** | Identity & authorisation | Entra ID OIDC authorisation-code + PKCE; group→role mapping with least-privilege resolution; server-side sessions with step-up; SPEC §5 permission matrix as data; capability **and** entity-scope axes; residency filter |
| **WP3** | Budget entry | Grid with categories, quarterly phasing, live totals; line drawer with every template field; local/EUR toggle with conversion before storage; bulk operations; volume drivers with headcount dormancy; optimistic concurrency |
| **WP4** | Actuals & consumption | Recorded spend restricted to elapsed periods; pace flagging; category/entity/group rollups; cascading filters; ledger-source protection |
| **WP5** | Workflow & approval | Draft→submitted→approved/changes-requested→locked; per-line decisions and approve-all; segregation of duties in `CHECK` constraints; cycle phase, lock date, late-edit exceptions, validation rules; capex asset-life approval |
| **WP6** | Reporting & export | Consolidation, variance, five-year trend, FX history, allocations, capex schedules; XLSX export with formula-injection defence |
| **WP7** | Audit & governance | Append-only audit by grant, trigger and SHA-256 chain; chain verification endpoint; classification and retention; data-subject export and pseudonymisation |
| **WP8** | Administration & operations | Template, categories, entities, owners, cost centres, FX, allocation pools, reminders; **admin-triggered encrypted backup** with chain attestation; consolidation export |
| **WP9** | Data preparation | Synthetic seed; **offline anonymiser** for the real workbook with k-anonymity reporting; `SEED_MODE` as a deployment option |
| **WP10** | Accessibility | WCAG 2.2 AA; axe against the running app across 8 views; palette contrast asserted arithmetically; keyboard-operable grid |
| **WP11** | Assurance | 360 automated tests against a real PostgreSQL; 8 CI gates; SBOM |
| **WP12** | Documentation | HLD, LLD, building blocks, ADRs, threat model (STRIDE + LINDDUN + ATT&CK + attack trees), security hardening, observability, accessibility, retention, secrets, Postgres TLS, Sweden compliance, DPIA input, pentest scope, OSINT assessment, user stories, per-role user guide, 28 flow diagrams |

### 4.2 Out of scope

Deliberately excluded from this SoW. Several are named in `SPEC.md` §11 as
decisions rather than omissions.

| Item | Note |
|---|---|
| Ledger integration for actuals (`FR-040`) | The seam exists (`actuals.source`); the feed is a separate engagement |
| Versions, scenarios, rolling forecast (`FR-080`) | Deferred by the spec. Amounts are already addressable by `(line, period, version)` so this is later a migration, not a rewrite |
| Configurable multi-stage approval (`FR-051`) | States and transitions built; reorderable stages not |
| Template versioning (`FR-005`) | |
| Depreciation flow-through into next year's opex (`FR-033`) | Schedule computed; flow-through not wired |
| **Restore from backup** | Deliberately excluded — an untested restore path invites false confidence. See §14 R2 |
| Infrastructure as code, environment provisioning, CI deployment stages | |
| OTLP telemetry export and SIEM integration | Events exist; export does not |
| Penetration test and DAST execution (`SEC-041`) | Scope defined in `docs/pentest-scope.md`; engagement is separate |
| Procurement/PO integration, contract lifecycle, multi-year capital planning, AI-assisted forecasting | `SPEC.md` §11 |
| Legal determinations: PIPL topology, NIS2 applicability, lawful basis, MBL | Client responsibility |

## 5. Deliverables

| # | Deliverable | Form | Status |
|---|---|---|---|
| D1 | Application source | Monorepo: `packages/shared`, `packages/api`, `packages/web` | Delivered |
| D2 | Database schema & migrations | `db/migrations/001`–`004`, incl. least-privilege roles and the audit chain | Delivered |
| D3 | Automated test suite | 360 tests: authorisation matrix (203 assertions), security, invariants, accessibility, operations | Delivered |
| D4 | CI pipeline | 8 gates incl. CodeQL, gitleaks, `npm audit`, SBOM, confidential-data guard | Delivered |
| D5 | Architecture documentation | HLD, LLD, building blocks (ABB/SBB), 5 ADRs | Delivered |
| D6 | Security documentation | Threat model, security hardening, NIST CSF + SP 800-207, OSINT assessment, pentest scope | Delivered |
| D7 | Compliance documentation | NIS2/GDPR/revFADP/APAC, Sweden-specific, DPIA input, retention, secrets, Postgres TLS | Delivered |
| D8 | Product documentation | User stories, application evaluation, per-role user guide with screenshots | Delivered |
| D9 | Functional flows | 28 Mermaid diagrams, rendered SVGs, browsable gallery | Delivered |
| D10 | Data preparation tooling | Offline anonymiser with k-anonymity reporting; synthetic seed | Delivered |
| D11 | This Statement of Work | Markdown and HTML | Delivered |

## 6. Approach & delivery phases

Spec Driven Development, per `SPEC.md` §0: *specify → plan → tasks → implement →
verify*. Two rules held throughout and are visible in the codebase:

- **No requirement ID, no code.** Every non-obvious control carries the ID it
  satisfies in a comment.
- **Never widen a role's permissions without changing §5 in the same commit.**
  The two operational capabilities added for backup are recorded in ADR-0005.

| Phase | Content | Output |
|---|---|---|
| P1 Foundation | Stack decision, schema, roles, audit chain, security wiring | ADR-0001/0002, migrations 001–003 |
| P2 Identity & authorisation | Entra adapter, sessions, matrix, guard | ADR-0003, 203 authorisation assertions |
| P3 Domain | Entry, drivers, actuals, workflow, reporting, export | WP3–WP6 |
| P4 Interface | Accessible SPA under strict CSP | WP10 |
| P5 Assurance | Test suite, CI gates, dependency reduction | ADR-0004 |
| P6 Governance | Threat model, compliance set, evaluation | WP12 |
| P7 Operations | Anonymiser, seed modes, backup | ADR-0005 |

## 7. Milestones & acceptance criteria

Each criterion is checkable, and most are already checked by a named test.

| M | Milestone | Acceptance criteria | Evidence |
|---|---|---|---|
| M1 | Security foundation | Undeclared route fails at registration; CSP has no `unsafe-inline`/`unsafe-eval`; production refuses dev auth, disabled rate limiting, plaintext origin and plaintext database | `security.test.ts` — headers, config fail-closed, route declarations |
| M2 | Authorisation complete | Every denied (role, capability) pair returns 403; read scope and write scope separate; out-of-scope reads return 404 | `authz.test.ts` — 203 assertions generated from the matrix |
| M3 | Financial correctness | No float arithmetic on money; parent = sum of children for every aggregate in every year; restating an FX rate moves no stored amount | `invariants.test.ts` |
| M4 | Audit non-repudiation | `UPDATE` and `DELETE` both refused; chain verification names the exact altered row after out-of-band tampering; a failed audit write rolls back the business change | `security.test.ts` — `FR-073` block |
| M5 | Workflow & segregation of duties | Submitter cannot approve; creator cannot approve their own cost centre — **both refused by the database** | `security.test.ts` — `SEC-012` block |
| M6 | Accessibility | Zero axe violations at WCAG 2.2 AA across 8 views in a real browser; contrast and type-scale asserted arithmetically | `a11y.test.ts` |
| M7 | Export safety | A vendor name beginning with `=` is inert in the delivered workbook, verified by inflating the real artefact | `security.test.ts` — `SEC-023` block |
| M8 | Operations | Backup is ciphertext on disk, round-trips, fails integrity check when tampered, refuses another region, attests the chain, requires fresh authentication | `operations.test.ts` |
| M9 | Data preparation | No identifying token from the source survives anonymisation; amounts jittered and rounded; order shuffled; k-anonymity reported | `operations.test.ts` |
| M10 | Documentation | HLD, LLD, building blocks, threat model, compliance set, user guide and flows delivered and consistent with the code | This document's §5 |

## 8. Roles & responsibilities (RACI)

| Activity | Delivery | Group IT Finance | CFO | Security | Legal / DPO | Platform |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Requirements (`SPEC.md`) | C | **A/R** | C | C | C | I |
| Architecture & ADRs | **A/R** | C | I | C | I | C |
| Build & test | **A/R** | I | I | C | I | I |
| Permission matrix sign-off | R | C | **A** | C | I | I |
| Threat model review | R | I | I | **A** | C | C |
| DPIA completion & lawful basis | C | C | I | C | **A/R** | I |
| PIPL topology decision (`CMP-140`) | C | C | I | C | **A/R** | C |
| NIS2 applicability (`CMP-120`) | I | I | I | C | **A/R** | I |
| Entra tenant: CA, PIM, FIDO2 | C | I | I | **A/R** | I | R |
| Environment provisioning & IaC | C | I | I | C | I | **A/R** |
| Penetration test engagement | C | I | I | **A/R** | I | C |
| Restore & DR runbook | C | I | I | C | I | **A/R** |
| UAT & acceptance | C | **A/R** | R | I | I | I |

*A = accountable, R = responsible, C = consulted, I = informed.*

## 9. Assumptions & dependencies

1. **Entra ID tenant access.** An application registration with group claims,
   plus test accounts for all nine roles. *The Entra integration has been built
   to the OIDC specification but never exercised against a live tenant* — first
   contact is a dependency, not a deliverable.
2. **Conditional Access, PIM and phishing-resistant MFA** are configured by the
   client. Spendifre re-checks the resulting claims and fails closed, but cannot
   create the policy.
3. **PostgreSQL 16** or Azure Database for PostgreSQL, with TLS and the ability
   to create three roles.
4. **The `CMP-140` PIPL decision** is made before hosting topology is finalised.
5. **The real workbook extract** stays out of any non-production database. The
   anonymiser is provided for that purpose.
6. Client provides the ledger interface specification when `FR-040` is scoped.
7. Legal completes the DPIA, lawful basis, privacy notice and MBL position.

## 10. Constraints

| Constraint | Consequence |
|---|---|
| Strict CSP with no `unsafe-inline` (`SEC-032`) | The approved prototype's inline styling could not be carried over; all styling is external CSS. Design intent is preserved; the markup is not |
| Type scale (`A11Y-001`) | The prototype's 9.5–11px body text cannot be reproduced. Density is recovered through line-height and padding at a 14px floor |
| No role switcher | The prototype's persona dropdown was a demo affordance; role comes from Entra groups |
| Fixed-precision money (`NFR-002`) | No float arithmetic anywhere; amounts cross the wire as decimal strings |
| Audit immutability (`FR-073`) vs retention (`PRIV-001`) | Resolved by a `SECURITY DEFINER` purge that re-anchors the hash chain; documented in `docs/retention.md` |
| Residency (`CMP-140`) | A deployment serves one region. Cross-region reporting is not possible by design |

## 11. Environment & technical requirements

| | |
|---|---|
| **Runtime** | Node.js 22 LTS |
| **Database** | PostgreSQL 16 (Azure Database for PostgreSQL in production) |
| **Identity** | Microsoft Entra ID; 9 groups `SG-Spendifre-*` |
| **Browser** | Current Chrome, Edge, Firefox, Safari |
| **Hosting** | Azure Container Apps behind Front Door + WAF; private networking only |
| **Secrets** | Azure Key Vault; workload identity preferred over passwords |
| **Regions** | Sweden Central (EU), Switzerland North (CH), Southeast Asia (APAC); mainland China unresolved |

Production configuration is validated at startup and **refuses to run** with dev
auth enabled, rate limiting disabled, a plaintext origin, a plaintext database
connection, a non-synthetic seed mode, or absent Entra configuration.

## 12. Security & compliance obligations

| Obligation | Commitment | Status |
|---|---|---|
| OWASP ASVS 5.0 L2; no OWASP Top 10 (2021) or API Top 10 (2023) finding | Baseline for the build | Met by design and test; **unconfirmed by penetration test** |
| Deny-by-default authorisation (`SEC-010`) | Undeclared route fails at registration | Met |
| Object-level authorisation (`SEC-011`) | Scope re-derived per request; 404 on out-of-scope reads | Met |
| Segregation of duties (`SEC-012`) | `CHECK` constraints, not handler logic alone | Met |
| Injection defence (`SEC-020`–`SEC-023`) | Bound parameters, identifier allow-list, lint gate, formula-injection guard | Met |
| XSS & CSP (`SEC-030`–`SEC-035`) | Context-escaping renderer, nonce CSP, CSRF + origin, no open redirect | Met |
| Zero Trust (`ZT-001`–`ZT-008`) | Per-request verification, device/AMR re-check, step-up, TLS to the database | Met in application; ZT-005/008 are deployment |
| Audit (`FR-070`–`FR-073`) | Append-only, hash-chained, transactional | Met |
| Retention & DSR (`PRIV-001`–`PRIV-003`) | Job-enforced; export and pseudonymisation as endpoints | Met |
| Non-production data (`PRIV-010`) | Synthetic by default; offline anonymiser; CI guard | Met, with the caveat in §14 R4 |
| Accessibility (`A11Y-001/2`, `CMP-160`) | WCAG 2.2 AA, CI-gated | Met; no external AT audit |
| Supply chain (`SEC-040`) | Lockfile, audit gate, SBOM, 6 direct production dependencies | Met; no artefact signing |
| SAST / secret scanning (`SEC-041`) | CodeQL + gitleaks gate every PR | Met; **DAST and pentest not run** |
| Threat model (`SEC-042`) | STRIDE + LINDDUN + ATT&CK + attack trees | Met |
| ISO 27001, NIST CSF 2.0, NIS2, GDPR/revFADP, APAC | Documented positions with named owners | Documented; **legal determinations open** |

## 13. Change control & governance

1. Changes are raised against a `SPEC.md` requirement ID. A change with no ID
   gets one first.
2. A change that widens a role's permissions **must** amend `SPEC.md` §5 in the
   same commit, and add the corresponding assertion.
3. Architecturally significant decisions are recorded as ADRs.
4. The threat model is reviewed when a trust boundary moves — a new ingress, a
   new processor, a new region, or a change to how identity is established.
5. No change merges with a failing CI gate.

## 14. Risks

| # | Risk | Likelihood | Impact | Owner | Mitigation / status |
|---|---|---|---|---|---|
| R1 | **PIPL topology unresolved** (`CMP-140`) | High | High — blocks CN go-live | Legal | The code fails closed today: an EU deployment 404s `cn` rows even for an administrator. The decision is outstanding |
| R2 | **Restore not implemented** | Certain | High | Platform | Deliberate. Backup is complete and chain-attesting; restore and a tested RTO/RPO are the next increment (`CMP-107`) |
| R3 | **Entra never exercised live** | High | Medium | Delivery + Security | First-contact testing against the tenant is a named dependency (§9.1) |
| R4 | **Real workbook present in the repository** | Confirmed | High | Group IT Finance | Contains live vendor names, contract values and named employees. The application cannot read it and CI enforces that; the file itself remains. See `docs/osint-exposure.md` §1 |
| R5 | **No penetration test or DAST** | Certain | Medium | Security | Scope written (`docs/pentest-scope.md`); engagement outstanding |
| R6 | **No telemetry to a SIEM** | Certain | Medium | Platform | Events and queries specified in `docs/observability.md` §3; export not wired |
| R7 | **Anonymised fixture is pseudonymous, not anonymous** | Confirmed | Medium | Legal | The tool reports 16 of 21 entities remain structurally unique. Classified `Internal`, gitignored, refused in production |
| R8 | **NIS2 applicability unknown** (`CMP-120`) | Medium | Medium | Legal | Unlikely by sector; commonly arrives via supply-chain clauses |
| R9 | **Adoption — the workbook is flexible** | Medium | High | Group IT Finance | A tool more rigid than what it replaces loses. Excel connectivity is the recommended next increment |

## 15. Commercials

| | |
|---|---|
| **Pricing model** | [fixed price / time & materials] |
| **Total** | [amount, currency] |
| **Payment schedule** | [tied to the milestones in §7] |
| **Expenses** | [policy] |
| **Rate card** | [roles and rates] |
| **Warranty period** | [duration] following acceptance |

## 16. Acceptance & sign-off

Acceptance is against §7. A milestone is accepted when its criteria pass on the
client's environment and the named evidence is reproducible by the client
running `npm test`.

| Party | Name | Role | Signature | Date |
|---|---|---|---|---|
| Client | [ ] | [ ] | | |
| Supplier | [ ] | [ ] | | |
| Security | [ ] | [ ] | | |
| Data protection | [ ] | [ ] | | |

## 17. References

| Document | Location |
|---|---|
| Specification | `SPEC.md` |
| Implementation summary | `IMPLEMENTATION.md` |
| High Level Design | `docs/architecture/hld.md` |
| Low Level Design | `docs/architecture/lld.md` |
| Building blocks (ABB/SBB) | `docs/architecture/building-blocks.md` |
| Decision records | `docs/adr/` |
| Threat model | `docs/threat-model.md` |
| Security hardening | `docs/security-hardening.md` |
| NIST CSF & Zero Trust | `docs/nist-and-zero-trust.md` |
| OSINT exposure | `docs/osint-exposure.md` |
| NIS2, GDPR, APAC | `docs/compliance-nis2-and-privacy.md` |
| Sweden-specific | `docs/compliance-sweden.md` |
| DPIA input | `docs/dpia-personnel-data.md` |
| Penetration test scope | `docs/pentest-scope.md` |
| Observability | `docs/observability.md` |
| Accessibility | `docs/accessibility.md` |
| Retention | `docs/retention.md` |
| Secrets | `docs/secrets.md` |
| PostgreSQL TLS | `docs/postgres-cert-auth.md` |
| User stories | `docs/user-stories.md` |
| Application evaluation | `docs/application-evaluation.md` |
| User guide | `docs/user-guide/README.md` |
| Functional flows | `SoW/flows.md` · `SoW/flows-gallery.html` |

---

## Appendix A — Functional flows

28 diagrams, sources in `SoW/flows/*.mmd`, rendered in
[`flows-gallery.html`](./flows-gallery.html) and inline in
[`flows.md`](./flows.md).

### A.1 System & data flows

Application map · authentication (OIDC + PKCE) · request lifecycle and
authorisation gate · budget entry round trip · line detail and drivers · bulk
operations · submission state machine · cost-centre lifecycle · actuals and pace
· FX restatement · consolidation fold · capex depreciation · allocations · audit
hash chain · retention and data-subject rights · backup · XLSX export ·
residency routing.

### A.2 User journeys (per role)

Budget owner · CFO · Administrator · Finance Manager (the dual role).

### A.3 Software-development interaction flows

Change lifecycle · CI gates · seed data and the anonymisation boundary · test
strategy · runtime topology · local development.

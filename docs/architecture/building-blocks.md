# Spendifre — Architecture Building Blocks

> TOGAF-style view for the ARB. **ABBs** are the capability-level blocks the
> solution requires; **SBBs** are the concrete things that realise them in this
> codebase. The traceability table is the part worth reviewing: it says which
> ABBs are actually realised, which are partial, and which are open.

## 1. Architecture Building Blocks (ABBs)

| ID | ABB | Capability required |
|---|---|---|
| ABB-01 | Identity & federation | Federated SSO, MFA, device posture, group-driven role assignment |
| ABB-02 | Authorisation | Deny-by-default capability model with object- and tenant-level scope |
| ABB-03 | Session management | Server-side sessions, revocation, step-up for high-impact actions |
| ABB-04 | Input validation | Allow-list schema validation at every boundary |
| ABB-05 | Persistence | Transactional relational store with least-privilege access |
| ABB-06 | Financial arithmetic | Fixed-precision money, deterministic rounding, FX at a locked rate |
| ABB-07 | Aggregation & reporting | Reconciling roll-ups across category, entity, group and year |
| ABB-08 | Workflow & approval | State machine with segregation of duties and server-side validation |
| ABB-09 | Audit & non-repudiation | Append-only, tamper-evident record of every state change |
| ABB-10 | Data governance | Classification, retention enforcement, data-subject rights |
| ABB-11 | Data residency | Region-bound storage and serving |
| ABB-12 | Interchange & export | Spreadsheet export safe in the recipient's tooling |
| ABB-13 | Backup & recovery | Encrypted, integrity-verified, restorable copies |
| ABB-14 | Secrets management | No secret at rest in source or image; rotation |
| ABB-15 | Observability | Structured telemetry, correlation, security alerting |
| ABB-16 | Presentation | Accessible, role-aware UI under a strict content policy |
| ABB-17 | Supply chain assurance | Pinned, scanned dependencies with an SBOM |
| ABB-18 | Test & release assurance | Automated gates that block merge on a failing control |
| ABB-19 | Non-production data | Development fixtures free of production data |
| ABB-20 | Planning & modelling | Scenarios, versions, driver trees, rolling forecast |
| ABB-21 | Actuals ingestion | Ledger-sourced actuals, commitments, reconciliation |

## 2. Solution Building Blocks (SBBs) and ABB realisation

| SBB | Realises | Implementation |
|---|---|---|
| SBB-01 Entra ID OIDC adapter | ABB-01 | `auth/oidc.ts` — authorisation code + PKCE S256, server-side state/nonce, group→role with least privilege on multi-membership |
| SBB-02 Permission matrix | ABB-02 | `shared/authz.ts` — SPEC §5 as frozen data; `can()` denies unknown role or capability |
| SBB-03 Route declaration hook | ABB-02 | `http/guard.ts` — `onRoute` throws at registration when `config.security` is absent |
| SBB-04 Scope resolver | ABB-02, ABB-11 | `routes/meta.ts` `visibleEntityIds()` — caller scope **and** deployment region, in one function every read path calls |
| SBB-05 Server-side sessions | ABB-03 | `auth/session.ts` — SHA-256 token at rest, `__Host-` cookie, `auth_time` for step-up, bulk revocation |
| SBB-06 Zod boundary schemas | ABB-04 | `shared/schemas.ts` — allow-list; predicates never throw |
| SBB-07 `sql` tagged template | ABB-05 | `db/pool.ts` — binds every value; `identifier()` allow-list for the one place binding cannot help |
| SBB-08 Three database roles | ABB-05 | `003_roles_and_grants.sql` — app has no DDL, no `DELETE` on audit; migrator and retention are separate |
| SBB-09 TLS to the database | ABB-05, ABB-14 | `DB_SSL_MODE` with `verify-full`; production refuses plaintext |
| SBB-10 `Money` value object | ABB-06 | `shared/money.ts` — scaled `bigint`, string-only construction, half-away-from-zero once per operation |
| SBB-11 Read-time FX | ABB-06 | `services/budget.ts` — amounts stored local; restating a rate restates every derived figure |
| SBB-12 Fold-based roll-ups | ABB-07 | `rollUp()` / `groupTotal()` — no stored parent exists to drift; `INV-4` property test |
| SBB-13 Submission state machine | ABB-08 | `routes/workflow.ts` + `submission_sod` / `cost_centre_sod` CHECK constraints |
| SBB-14 Server-side rule engine | ABB-08 | `services/editability.ts` — named queries, not user-authored expressions; blocking rules refuse submission |
| SBB-15 Append-only audit | ABB-09 | `002_audit.sql` — grants + trigger + SHA-256 chain; insert shares the handler transaction |
| SBB-16 Audit completeness hook | ABB-09 | `services/audit.ts` — a 2xx state change with no audit event fails in test, alerts in production |
| SBB-17 Governance tables & endpoints | ABB-10 | `data_classifications`, `retention_policies`, subject export and pseudonymisation as first-class endpoints |
| SBB-18 Retention job | ABB-10 | `audit_purge_expired()` `SECURITY DEFINER` + chain re-anchor; audited with counts |
| SBB-19 OOXML writer | ABB-12 | `services/xlsx.ts` — dependency-free; formula guard on every text cell |
| SBB-20 Encrypted backup | ABB-13 | `services/backup.ts` — AES-256-GCM, AAD binds id+region, SHA-256, chain attestation |
| SBB-21 Config fail-closed | ABB-14 | `config.ts` — no secret has a default; production refuses dev auth, disabled rate limiting, plaintext origin or DB |
| SBB-22 Structured logging | ABB-15 | Pino with credential redaction, request correlation ids, CSP report sink |
| SBB-23 CSP + header set | ABB-16 | `http/security.ts` — per-response nonce, no `unsafe-inline`/`unsafe-eval` |
| SBB-24 Accessible design system | ABB-16 | External CSS tokens, 14px floor, glyph beside every status colour, keyboard-operable grid |
| SBB-25 CI gate set | ABB-17, ABB-18 | typecheck, lint (SQL/XSS/float rules), `npm audit`, CodeQL, gitleaks, SBOM, 360 tests, confidential-data grep |
| SBB-26 Anonymiser + seed modes | ABB-19 | `tools/anonymise.ts` offline; `SEED_MODE` synthetic \| anonymised; production refuses non-synthetic |
| SBB-27 Version-addressable amounts | ABB-20 (partial) | `(line, fiscal_year, period, budget_version)` from day one; only `working` is written |
| SBB-28 Driver links | ABB-20 (partial) | Single driver with rate per unit; computed, read-only, dormant when planning is off |
| SBB-29 Manual actuals | ABB-21 (partial) | `actuals.source` distinguishes `manual` from `ledger`; ledger-owned periods refuse hand edits |

## 3. Traceability (ABB → SBB)

| ABB | Realised by | Status |
|---|---|---|
| ABB-01 Identity | SBB-01 | **Built, never run against a real tenant.** Conditional Access, PIM and FIDO2 enforcement are tenant configuration. |
| ABB-02 Authorisation | SBB-02, 03, 04 | **Complete.** 203 assertions cover every role × capability pair. |
| ABB-03 Sessions | SBB-05 | **Complete.** Risk-signal revocation is manual; Entra risk events are not wired. |
| ABB-04 Validation | SBB-06 | **Complete.** |
| ABB-05 Persistence | SBB-07, 08, 09 | **Complete.** |
| ABB-06 Money | SBB-10, 11 | **Complete.** |
| ABB-07 Aggregation | SBB-12 | **Complete** at current volume. Re-measure at monthly × versions. |
| ABB-08 Workflow | SBB-13, 14 | **Partial.** States, SoD and blocking rules exist; configurable multi-stage approval (`FR-051`) does not. |
| ABB-09 Audit | SBB-15, 16 | **Complete.** |
| ABB-10 Governance | SBB-17, 18 | **Complete in code.** Legal artefacts (RoPA, DPIA, notice) are open. |
| ABB-11 Residency | SBB-04 | **Enforced in code; topology undecided** (`CMP-140`). |
| ABB-12 Export | SBB-19 | **Complete.** |
| ABB-13 Backup & recovery | SBB-20 | **Half.** Backup is complete and verified; **restore is not implemented.** |
| ABB-14 Secrets | SBB-09, 21 | **Complete in code.** Key Vault wiring and rotation evidence are deployment. |
| ABB-15 Observability | SBB-22 | **Partial.** Structured logs and audit metrics; no OTLP traces, no SIEM shipping, no alert rules. |
| ABB-16 Presentation | SBB-23, 24 | **Complete.** axe clean across eight views. |
| ABB-17 Supply chain | SBB-25 | **Partial.** Pinned, scanned, SBOM per build; artefact signing and reproducible builds are open. |
| ABB-18 Test & release | SBB-25 | **Partial.** Merge gates are complete; DAST and penetration test are not run. |
| ABB-19 Non-production data | SBB-26 | **Complete**, with the honest caveat that the anonymised fixture is pseudonymous, not anonymous. |
| ABB-20 Planning & modelling | SBB-27, 28 | **Thin.** Schema is ready for scenarios; no scenario UI, no rolling forecast, no driver trees. |
| ABB-21 Actuals ingestion | SBB-29 | **Manual only.** No ledger feed, no commitments, no reconciliation. |

## 4. Gaps & roadmap building blocks

Blocks the ARB should expect to see proposed next, in the order they earn their
place:

| Candidate block | Closes | Note |
|---|---|---|
| **Ledger connector** | ABB-21 | Largest functional gap. `actuals.source` is already the seam. |
| **Restore & DR runbook** | ABB-13 | Backup without a tested restore is not a backup (`CMP-107`). |
| **OTLP exporter + SIEM rules** | ABB-15 | Three named alerts: privilege change, mass export, audit-write failure. |
| **Scenario/version dimension** | ABB-20 | Cheap now: the key already exists, only `working` is written. |
| **Commitments & accruals** | ABB-21 | Plan vs actual without commitments understates until it doesn't. |
| **Excel bidirectional connector** | ABB-12 | Largest adoption lever when replacing a workbook. |
| **Contract & renewal register** | new | Contract terms currently live in free text in the source workbook. |
| **TBM taxonomy view** | new | Cost pools → towers → services; the standard for IT cost transparency. |
| **Multi-stage approval** | ABB-08 | `FR-051`. |
| **IaC + DAST + penetration test** | ABB-18 | `SEC-041`, required before go-live. |

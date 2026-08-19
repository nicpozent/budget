# Spendifre — Application Evaluation

A structured assessment against engineering and product quality dimensions.
Ratings are evidence-based (code, tests, CI, ADRs) and deliberately unkind where
the evidence is thin. Scale:

- **★★★★★ Excellent** — implemented, tested, documented, production-grade.
- **★★★★☆ Strong** — implemented and tested; minor gaps noted.
- **★★★☆☆ Adequate** — implemented; partial tests/docs or known limitations.
- **★★☆☆☆ Partial** — scaffolded / in progress.
- **★☆☆☆☆ Absent** — not started.

*Last reviewed: v1.2, `claude/file-review-8a42qx`. 524 tests, 0 lint errors,
0 dependency vulnerabilities, 6 direct production dependencies.*

*Rows 1, 2, 3, 9, 10, 12, 13, 14, 15, 16, 17, 18 and 21 have been re-scored
across two revisions. Each states what changed; what did not change is still
stated as a gap, and two rows deliberately did not move.*

## 1. Scorecard

| # | Dimension | Rating | Evidence | Gaps / next |
|---|---|---|---|---|
| 1 | **Functional coverage** (vs `SPEC.md`) | ★★★★☆ | Everything previously listed, plus the four gaps closed: **`FR-040`** idempotent ledger batch ingest with stored rejects and residency enforcement; **`FR-051`** ordered approval stages with role and threshold conditions that actually gate; **`FR-005`** immutable published template versions with in-flight budgets pinned; **`FR-033`** next year's depreciation as derived read-only opex lines. Screens added for trend, FX history, allocations and scenarios — all 13 views axe-clean. **`FR-080`** budget versions, scenarios and a rolling forecast, with a foreign key and a lock behind them; **`FR-020`** derived driver trees | No live feed is connected to the `FR-040` endpoint and there is no service principal to run it; `FR-051` and `FR-005` are API-complete with no admin screen; no formula engine, deliberately (ADR 0007) |
| 2 | **Architecture & modularity** | ★★★★★ | npm workspaces; pure `shared` package (no I/O) so the matrix and money type are directly testable; **routes split by domain, services by layer** (ADR-0006), keeping `guard.ts`/`pool.ts`/`audit.ts` singular and reviewable; FR-051's gating logic is a pure function tested without a request; HLD + LLD + building blocks + 7 ADRs. Layering is asserted rather than assumed: no service imports a route, `shared` imports nothing upward, and the client never reaches into the API package | **`admin.ts` drifted back into being the file ADR-0006 exists to forbid** — 712 lines and four unrelated domains, held together only by the fact that an administrator performs all of them. Split into `reference`, `drivers`, `governance` and `operations`; no route module now exceeds 600 lines. Worth recording because the ADR named the failure mode and it happened anyway: a module named after a *role* will accept anything that role can do |
| 3 | **Frontend engineering** | ★★★★★ | React 18 + TS strict + Vite 6; external CSS tokens (no inline styles — the CSP forbids them); 0 lint errors; deterministic asset names; **route-level splitting** (98 KB app + 143 KB vendor + per-view chunks a role may never fetch) with the split **asserted in a real browser under the real CSP**, because a dynamic import does not inherit the shell nonce; shared store on `useSyncExternalStore` replacing per-view refetching | Splitting is per view, not per route segment — there is no router. Deliberate: the client owns one navigation state |
| 4 | **Identity & access** | ★★★☆☆ | Entra OIDC authorisation code + **PKCE S256**, server-side state/nonce single-use, group→role with least privilege on multi-membership, JIT provisioning with safe account linking | **Never exercised against a live tenant.** The dev provider is what has been run. Conditional Access / PIM / FIDO2 are tenant configuration |
| 5 | **Authorization model** | ★★★★★ | SPEC §5 matrix as frozen data; **an undeclared route throws at registration** so it cannot reach a running server; capability and entity scope as separate axes; 404-not-403 on out-of-scope reads; **252 assertions covering every role × capability pair** (28 capabilities × 9 roles), generated from the matrix so a new capability without a probe fails the suite | — |
| 6 | **Data & persistence** | ★★★★★ | PostgreSQL 16; three least-privilege roles; `numeric(18,4)` money with no float column anywhere; amounts addressable by `(line, year, period, version)` from day one; SoD as `CHECK` constraints; checksum-guarded migrations | — |
| 7 | **Financial correctness** | ★★★★★ | `Money` over scaled `bigint`, string-only construction, rounding stated once; FX at read time so restatement is consistent; **`INV-4` property-tested over two partitions × five years**; optimistic concurrency with a real conflict path | — |
| 8 | **Audit & non-repudiation** | ★★★★★ | Append-only by **grant, trigger and SHA-256 hash chain**; audit insert shares the handler transaction so an unrecorded change rolls back; `audit_verify_chain()` pinpoints tampering performed with the trigger disabled; completeness hook fails a 2xx state change that wrote no event | — |
| 9 | **Security & hardening** | ★★★★☆ | Nonce CSP with no `unsafe-inline`; full header set; CSRF token + origin check + `SameSite`; rate limiting incl. per-route; bound-parameter SQL with an allow-list for identifiers and **lint rules that block the alternatives**; formula-injection guard verified by inflating a real workbook; step-up on irreversible actions; config fails closed in production; TLS to the database with `verify-full`; **15-minute idle timeout now enforced** rather than merely recorded; **ZAP baseline in CI** with injection and XSS rules set to fail; **Sigstore signing and SLSA provenance** on the image | **No penetration test** (`SEC-041`) — a scan is not a pen test, and the DAST stage runs with DEV_AUTH on so the scanner gets past the front door, which is the one way the scanned system differs from production |
| 10 | **Privacy & data protection** | ★★★★☆ | Classification per field; retention enforced by a job that audits its counts; DSAR export and **erasure that pseudonymises while keeping the audit chain intact**; IP/UA only as salted hashes; residency enforced in the single scope resolver. **RoPA, employee privacy notice, lawful-basis assessment with a full legitimate-interests balancing test, and a purpose-limitation commitment are now drafted** (`ropa.md`, `privacy-notice.md`, `lawful-basis.md`) | Still ★★★★ because **drafted is not adopted**: a controller decides the lawful basis and issues the notice, and every `[org]` placeholder is a real unknown. The balancing test is explicitly conditional on the purpose-limitation wording being adopted. `CMP-140` PIPL unresolved, and the GDPR reasoning does not transfer to it |
| 11 | **Non-production data** | ★★★★☆ | Synthetic seed by default; offline anonymiser outside `packages/`; CI refuses any import of the workbook; **the anonymiser reports its own k-anonymity failure** rather than overclaiming | The real extract is still in the repository (`osint-exposure.md` §1); the anonymised fixture is pseudonymous, not anonymous |
| 12 | **Accessibility (WCAG 2.2 AA)** | ★★★★☆ | **WCAG 2.2.1 now met**: the session warns two minutes before the idle timeout with a Continue action, and says so plainly when it is the absolute TTL that cannot be extended. | axe across **13 views** in a real browser; contrast asserted arithmetically for both themes; type-scale floor parsed from tokens; non-colour cue beside every status; real table semantics; keyboard-operable scroll regions. **VPAT 2.5 / EN 301 549 report** criterion by criterion, marking which claims are verified and which are code-reading. **NFR-010 catalogue**: every client string typed, with a test that fails on JSX text bypassing it — it found 120. **WCAG 4.1.3 fixed** while writing the VPAT: banners were not live regions | Still ★★★★ for one reason: **no assistive-technology user has tested this.** Automated checks catch roughly a third of WCAG issues. six locales, none native-reviewed. A hover-contrast defect found this revision — the `background` shorthand on `:hover` wiped every primary button's gradient, leaving near-black text on grey — suggests other state-dependent contrast problems automated tooling cannot see |
| 13 | **Observability** | ★★★★☆ | Structured JSON logs with credential redaction; per-request correlation ids; every authorisation denial logged with its reason; CSP violation sink; audit-completeness signal; health endpoint. **Prometheus metrics** behind a bearer token that is unregistered without one; **OTLP/HTTP tracing** joining an inbound W3C traceparent, deterministically sampled, dropping rather than queueing without bound; **the three ZT-008 alerts as loadable rules** in Prometheus and KQL form, deployed by the Bicep. Route labels use the pattern and spans carry role not identity — asserted by a test that drives a real id through and checks it does not appear | No SIEM is actually receiving any of it: the rules exist and nothing is subscribed. That is a deployment step, not a code one |
| 14 | **Testing** | ★★★★★ | 589 tests against a **real PostgreSQL** (throwaway DB per run) because constraints, triggers and grants are half the controls; authz matrix, security regressions, invariant properties, browser a11y, operations; **real defects found by the suite and by review during build** and each now has a regression test **Runtime self-test**: 18 read-only checks over live data, runnable from the Operations view, PowerShell, `npm run selftest` or any scheduler, with tests that break the system on purpose to prove each check can fail. **Load test at monthly × three-version scale** (`npm run loadtest`) | **The load test found a real NFR-001 breach, and the breach is now fixed**: at 30k period rows four of six report routes exceeded the 300 ms p95 budget, trend worst at 557 ms; the fold moved into SQL and the worst p95 is 195 ms with throughput up from 88 to 171 requests a second. The equivalence of the two implementations is asserted over the whole seeded dataset rather than assumed, and doing it turned up two more defects (a drifted EUR rate in the fixture, and a load-test tool that measured with the rate limiter on). No mutation testing |
| 15 | **CI/CD** | ★★★★★ | 8 gates plus a release pipeline that builds, SBOMs *from the image*, signs with Sigstore keyless, attests provenance and the SBOM, scans, and only then runs DAST against it running — in that order, because a signature on an unscanned image is not the claim anyone needs | Base images are pinned by version tag, not digest, with CI recording the resolved digests in the attestation. A deliberate half-measure with its reasoning stated in the Dockerfile |
| 16 | **Delivery & runtime** | ★★★★☆ | Distroless non-root image with no shell; Bicep for the whole environment — passwordless PostgreSQL over a private endpoint, Key Vault with purge protection, alerts as resources — one deployment per residency region | **Nothing has been deployed.** The template has never been applied to a subscription, so it is unproven in exactly the way the Entra client is |
| 17 | **Backup & recovery** | ★★★★☆ | Encrypted, integrity double-checked, chain-attesting, audited with counts. **Restore implemented and round-trip tested** against two real databases: every table's row count, the audit chain still verifying, the anchor re-pointed, and the sum of amounts identical rather than approximately equal. Restore is a CLI, not an endpoint, because it truncates the audit trail. A read-only verify endpoint is safe to run against production on a schedule | **No published RTO/RPO.** The mechanism works; the commitment is still a `CMP-107` open item, and only the organisation can make it |
| 18 | **Supply chain** | ★★★★★ | Still 6 direct production dependencies — metrics, tracing and the OTLP exporter were all written rather than taken, on ADR-0004's reasoning. Lockfile; `npm audit` at high; SBOM generated **from the built image**; Sigstore keyless signing with no private key to steal; SLSA provenance and SBOM attestations pushed to the registry; Trivy failing on a fixable high | — |
| 19 | **Governance & compliance** | ★★★★☆ | Threat model (STRIDE + LINDDUN + ATT&CK + attack trees), NIST CSF 2.0 profile, SP 800-207 maturity assessment, NIS2 position, GDPR/revFADP, Sweden-specific, DPIA input, pentest scope, OSINT assessment | Legal decisions outstanding: `CMP-140` PIPL (**blocks hosting**), `CMP-120` NIS2, lawful basis, MBL |
| 20 | **Modelling depth** | ★★★★☆ | Driver link with rate per unit; even spread with remainder; headcount toggle with dormancy; allocation pools on one driver key. **`FR-080` built**: budget versions as a table with a key, a kind and a lock, a foreign key from every amount, set-based copy, a rolling forecast rebased from actuals for closed periods, and a comparison screen that folds both sides through the same query. **Driver trees**: a driver can be defined as a sum of terms over other drivers — `1.5 per head + 2 per site` — resolved on write with cycle detection, rounded once over the sum so it matches hand arithmetic, re-derived by the self-test, and edited from a screen | **No formula engine, and ADR 0007 argues there should not be one** — a user-authored expression language is an interpreter for untrusted input in a codebase whose SQL and validation story is that nothing supplied is ever interpreted, and it is a second definition of every number that no test or review sees. Not five stars: scenarios are read-only about figures — you edit the working plan and copy — which is a deliberate choice rather than a gap, but it is still a thing the tool does not do |
| 21 | **i18n** | ★★★★☆ | **Six locales** — English, Swedish, Norwegian bokmål, Danish, Finnish, French — stored per user rather than sniffed per browser, so a Finnish controller on a shared Swedish workstation gets Finnish. Number and date formatting follows the choice; `<html lang>` follows it too (WCAG 3.1.1). Each catalogue is typed against English, and tests assert identical key sets, identical placeholders, and no untranslated string outside a checked list of genuine cognates | **No native speaker has reviewed any of the five translations.** They are competent, not professional, and finance terminology is exactly where a plausible-but-wrong word does damage. Every file says so at the top |
| 22 | **Documentation** | ★★★★★ | HLD, LLD, building blocks, 6 ADRs, threat model, security hardening, observability, accessibility, VPAT, retention, secrets, Postgres TLS, Sweden compliance, DPIA, RoPA, lawful basis, privacy notice, pentest scope, OSINT, user stories, per-role user guide with screenshots, SoW with 28 flow diagrams | — |
| 23 | **Maintainability / DX** | ★★★★☆ | Consistent patterns; comments explain *why* and cite requirement IDs; one command to migrate, seed, build and run; screenshots and flows regenerate from source | Node type-stripping means no parameter properties or enums — a small, documented constraint |

## 2. Dimension notes

**Authorization (5) is the strongest dimension** and deliberately so. The
`onRoute` hook converts `SEC-010` from a review item into a framework
guarantee: a route without a security declaration throws at registration, so it
cannot reach a running server. The 252 assertions are generated *from the
matrix*, which means adding a capability without wiring an endpoint fails the
suite — the test cannot silently fall behind the model. That is not
hypothetical: adding four capabilities for FR-005, FR-040 and FR-051 failed the
suite immediately, before a line of the new features had been wired up.

**Audit (8) is the second.** Three independent controls — grants, trigger, hash
chain — because any one can be misconfigured. The chain earns its place: a test
disables the trigger, edits a row out of band, and asserts
`audit_verify_chain()` names the exact sequence. That is the compromised-DBA and
doctored-restore case, which grants and triggers cannot touch.

**Observability (13) is the weakest**, and it is a real gap rather than a
documentation one. Everything needed to *investigate* an incident exists; what
is missing is anything that would *tell you* one is happening. The three
`ZT-008` alerts are specified in `observability.md` §3 with the exact queries;
nothing emits to a SIEM.

**Identity (4) is rated 3 stars despite good code** because it has never run
against a live tenant. The adapter is written to the OIDC specification with
PKCE and single-use server-side state, and `mapGroupsToRole` is unit-tested —
but "written correctly" and "verified end to end" are different claims and
should not be conflated in an evaluation.

**Functional coverage (1) moved from 3 to 4 stars, not 5.** The four FR gaps are
closed and the three missing screens exist, but "the ledger endpoint is built and
tested" is a different claim from "actuals arrive from the ledger", and only the
second one is what a finance team wants. The remaining star is a live feed, a
service principal to run it, and a restore path.

**Privacy (10) stayed at 4 stars despite four new documents**, and that is the
point. Drafting a RoPA does not make it the controller's record; drafting a
privacy notice does not issue it. The documents remove the excuse that nobody
knew what to write — they do not remove the decision.

**Observability (13) moved from 2 stars to 4, and stops there.** The
instrumentation exists and the alert rules are loadable files rather than a
table in a document — but nothing is subscribed to them. "The rule is written"
and "someone gets paged" are different claims, and only the first is true.

**Testing (14) found a performance breach, and the breach is fixed.** That is
the intended outcome of adding a load test. At monthly × three-version scale the
reporting routes missed NFR-001's 300 ms p95, worst at 557 ms; the fold now runs
in the database and the worst p95 is 195 ms.

Getting there took three measurements, not one, and each pointed somewhere
different from the last. Moving the fold into SQL roughly halved the cost of a
report and was not enough. Batching five years into one statement helped the
trend and not the rest. What actually closed the gap was watching the process
under load: Node sat at one saturated core while the ten PostgreSQL backends
between them used 1.4 — the bottleneck was 2,940 rows a request crossing into
JavaScript to be turned into `Money` objects and immediately summed away. FR-060
renders 29 numbers and was parsing 588 rows to get them. Grouping in the
database took the whole suite from 88 to 171 requests a second.

The risk in this was always INV-4, so the guard is equivalence rather than
inspection: `computeLineTotals` is kept as the readable definition and the tests
assert, over the whole seeded dataset and in five years, that the SQL fold
matches it row for row, that the grouped query matches folding those rows in
JavaScript, and that the variance ranking matches the sort it replaced. Two of
those tests failed the first time they ran, which is the argument for writing
them: the fixture had been drifting the EUR rate away from 1 for historical
years, and `loadFxTable` was quietly masking it.

**Modelling depth (20) went from two stars to four, and the missing fifth is a
decision.** SPEC §11 deferred versions and scenarios and asked only that the
schema not preclude them; that bet paid off — `budget_version` had been part of
the primary key since day one, so the increment was a migration and a service
rather than a rewrite. Versions, scenarios, a rolling forecast and driver trees
are all built and tested.

The formula engine is not, and [ADR 0007](adr/0007-modelling-depth.md) is the
argument rather than an apology. It is the one item on that list that is unlike
the others: a user-authored expression stored as text and evaluated against data
is an interpreter for untrusted input, in a codebase whose entire SQL and
validation story is that nothing supplied is ever interpreted. It is also a
second definition of every number it touches, authored without review, without a
test and without a diff — which is the failure this evaluation's first finding
describes, with a nicer interface. Spendifre is a governed system of record;
best-of-breed planning tools are calculation engines with a system of record
attached, and adding an expression language would make it a worse example of
both.

**Testing (14).** Worth recording that the suite found five genuine defects
during construction. The two most recent: the **audit-completeness hook refused
the ledger replay path** — a POST returning 200 with no audit event — which was
correct, and is now recorded rather than exempted; and the **route-splitting
assertion caught that `views.tsx` was both statically and dynamically imported**,
so the lazy imports were inert and the bundle had not actually split. The
original three: FX rates capped at 4 decimal places against a
`numeric(18,8)` column (making VND, LAK and KRW unadministrable, *and* throwing
inside a Zod refine so a 422 became a 500); the residency filter applied only to
the entity list, so consolidation summed Swiss and Chinese entities into a EUR
total served from the EU deployment; and framework-level 4xx errors reported as
500. All three are now regression-tested.

## 3. Top risks & recommended next steps

| # | Risk | Impact | Recommendation |
|---|---|---|---|
| 1 | **Cross-border transfer, and it is not only China** | The topology is decided — one central deployment — which **removes** the arrangement in which nothing crossed a border. Serving `apac` means Singapore, Indian and Vietnamese data processed in the EU, so `CMP-141`/`CMP-143`/`CMP-145` join `CMP-140` as go-live blockers. Found by sweeping every requirement ID in `SPEC.md` against the codebase: three of them (`CMP-142`–`CMP-144`) are referenced nowhere outside the spec | Legal, per jurisdiction — and now only Legal. The code fails closed and its granularity is the jurisdiction: `entities.country` records an ISO code, `residency` is derived from it by a composite foreign key, and `SERVED_COUNTRIES` narrows within a served bucket, so "serve Singapore, not Vietnam" is expressible. The country for a real entity is still a fact someone must supply; the migration refuses to guess it |
| 2 | **No published RTO/RPO** | Restore works and is round-trip tested, but nobody has committed to how fast or how much loss is acceptable | `CMP-107`. The mechanism is done; the commitment is the organisation's |
| 3 | **Real workbook in the repository** | Vendor map, contract values and named employees exposed if the repo is or was public | Confirm visibility; remove; treat prior exposure as disclosure |
| 4 | **No penetration test, no DAST** | Unknown unknowns in exactly the business-logic paths automation cannot reason about | Engage against staging using `pentest-scope.md` |
| 5 | **Alert rules exist; nothing is subscribed** | The metrics, traces and rules are all in place. Until a SIEM ingests them, a broken audit chain is still discovered by someone looking | Point a collector at the OTLP endpoint and load `ops/alerts/` |
| 6 | **Entra never tested live** | Sign-in may fail on first contact with the tenant | Stand up the app registration and run the flow end to end |
| 7 | **No ledger feed connected** | The ingest endpoint is built and tested; nothing sends to it, so actuals are still hand-typed | Choose the source system and stand up the job. A service principal holding `ledger.ingest` alone is the missing identity |
| 8 | **The IaC has never been applied** | Bicep exists for the whole environment; no subscription has run it, so it is unproven in the same way the Entra client is | Apply it to a non-production subscription and find out what is wrong with it |
| 9 | **Anonymised fixture is pseudonymous** | Could be described as anonymous in a RoPA and be wrong | Already documented, and `ropa.md` §5 names it. Needs Legal to agree the classification |
| 10 | **No assistive-technology testing** | `vpat.md` claims conformance a screen-reader user has never checked; a VPAT that overstates is worse than none | Commission a screen-reader audit. The rows marked *not independently verified* are where to start |

## 4. Overall

**★★★★☆ — strong engineering, largely complete product, still undeployed.**

The security, correctness and governance foundations are genuinely above what an
internal tool of this size usually gets: authorisation that fails closed at
registration time, an audit trail that detects tampering it cannot prevent,
money that cannot lose precision, and a test suite that found three real defects
while being written. The documentation set is complete enough for an ARB.

The functional gaps that made the previous revision score three stars on
coverage are closed: the ledger seam, configurable approval stages, template
versioning, depreciation flow-through, and the three reports that had endpoints
and no screen.

Against that: it has never been deployed, never met a live Entra tenant, cannot
restore its own backups, has no telemetry, has never been used with a screen
reader, and its planning model is thin compared with a commercial planning tool.
The privacy artefacts are drafted but not adopted, which is a decision the
organisation has to make rather than work anyone can do for it. None of these is
a design flaw; all are work not yet done, and each is named in this document
rather than left to be discovered.

Since the previous revision the deployment-readiness list has largely been
built rather than described: restore is implemented and round-trip tested,
telemetry and alert rules exist, there is a container image and a Bicep
environment, and the release pipeline signs and attests what it produces.

**What that has not changed is that none of it has met production.** The image
has not been deployed, the Bicep has not been applied to a subscription, no SIEM
is subscribed to the alerts, the Entra client has never seen a real tenant, no
screen-reader user has tried the interface, and no native speaker has read the
translations. Every one of those is a first-contact task that will produce
findings, and the volume of code here does not reduce that.

**Recommended posture:** stop adding functionality. The next increment is
first contact with reality, in this order — apply the Bicep to a non-production
subscription, point it at a real Entra tenant, subscribe a SIEM, run the
penetration test against it, commission a screen-reader audit and a translation
review, and publish an RTO/RPO backed by an actual timed restore. Every item on
that list is first contact with something outside this repository, which is
exactly why none of it can be finished from here.

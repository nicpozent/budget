# Spendifre — implementation

The design bundle described in `README.md` is now built. `SPEC.md` remains the
contract; this file explains what exists, how to run it, and — most usefully —
what is **not** done.

```
packages/shared    money, the SPEC §5 permission matrix, domain types, boundary schemas
packages/api       Fastify API, auth, authorisation, audit, reporting, export, backup
packages/web       React client, design tokens, accessible grid
db/migrations      schema, append-only audit, least-privilege roles, backup manifests
db/fixtures        generated anonymised seed (gitignored — see below)
tools/             offline tooling; the anonymiser lives here, not in packages/
design/            the original prototypes, logos, and the real workbook extract
docs/              architecture, security, privacy, operations — see docs/README.md
docs/adr           seven decisions with their reasoning
docs/user-guide    per-role guide, every feature, with screenshots
SoW/               statement of work and the 28 flow diagrams
ops/               alert rules, Bicep for the Azure environment, the PowerShell
                   self-test runner
test/              589 tests: authorisation matrix, security, invariants, a11y,
                   operations, feature semantics, client catalogue
```

### Why the layout is this shape

Three of these boundaries are load-bearing rather than tidy:

- **`tools/` is outside `packages/`** so the anonymiser can read the confidential
  workbook while the application provably cannot. CI greps `packages/` and
  `test/` for any reference to it and fails the build; keeping the tool outside
  that tree means the gate needs no exception.
- **`db/` is outside `packages/api`** because migrations run as a different
  database role than the application (SEC-021). The directory boundary mirrors
  the privilege boundary.
- **`design/` holds reference material, not source.** The prototypes are the
  visual contract and `budget-data.js` is a migration input; neither is built,
  imported or deployed. Keeping them out of the root makes the confidential
  file's location explicit rather than incidental.

Inside `packages/api`, **routes are split by domain and everything else by
layer** — see [ADR 0006](docs/adr/0006-module-structure.md). The layer split held
until four subsystems arrived at once (FR-005, FR-033, FR-040, FR-051) and
`admin.ts` would have become a thousand-line file whose name meant "the rest".
Routes moved to domain modules; `services/`, `http/`, `db/` and `auth/` did not,
because their value is that there is exactly one `guard.ts`, one `pool.ts` and
one `audit.ts` to review.

`admin.ts` then drifted back into being exactly the file the ADR warned about —
712 lines holding reference data, drivers, governance and operations — and has
since been split into those four. No route module is over 600 lines and no
service over 800.

## Running it

```bash
npm ci

createdb spendifre
MIGRATION_DATABASE_URL=postgres://…/spendifre npm run db:migrate
DATABASE_URL=postgres://…/spendifre         npm run db:seed   # synthetic — PRIV-010

cp .env.example .env      # DEV_AUTH=on for local sign-in
npm run build             # frontend
npm run dev               # http://localhost:8080
```

Sign in as any seeded persona: `admin@`, `cfo@`, `finance@`, `cio@`, `cto@`,
`infra@`, `security@`, `architecture@`, `pmo@` — all `@birgma.test`.

```bash
npm test          # needs a local PostgreSQL; builds a throwaway DB per run
npm run typecheck
npm run lint
npm run audit:ci
```

## What the security requirements turned into

| Requirement | Where it lives |
|---|---|
| `SEC-010` deny by default, undeclared route fails the build | `http/guard.ts` — an `onRoute` hook **refuses to register** a route with no security declaration |
| `SEC-011` object-level authz, 404 not 403 on reads | `requireReadEntity` / `requireWriteEntity`; scope re-derived from the session every request |
| `SEC-012` segregation of duties in data | `CHECK` constraints on `submissions` and `cost_centres`, not just handler checks |
| `SEC-013` rate limiting | Global, plus tighter limits on auth, export and bulk operations |
| `SEC-020` no concatenated SQL | `sql` tagged template binds every value; allow-list for dynamic identifiers; ESLint rule blocks the alternatives |
| `SEC-021` least-privilege DB roles | Three roles; the app holds no DDL and no `DELETE` on audit |
| `SEC-022` boundary validation | Zod schemas, allow-list; `Money` rejects `NaN`, `Infinity` and exponent notation |
| `SEC-023` formula injection | `escapeSpreadsheetValue`, applied to every text cell in the export |
| `SEC-030`–`SEC-035` XSS, CSP, cookies, redirects | `http/security.ts`; nonce-based CSP with no `unsafe-inline` |
| `ZT-001`–`ZT-008` Zero Trust | `auth/session.ts`, `http/guard.ts`; see `docs/nist-and-zero-trust.md` |
| `FR-070`–`FR-073` audit | Append-only by grant **and** trigger **and** SHA-256 hash chain |
| `A11Y-001`/`A11Y-002` | axe against the running app in a real browser, plus contrast maths over the palette |

## Seed modes (ADR 0005)

`SEED_MODE` chooses the dataset. It is a deployment option, and both modes
converge on the same structure before anything touches the database, so they
cannot drift in what they exercise.

```bash
SEED_MODE=synthetic npm run db:seed     # default: invented, safe by construction

# Anonymised: real structure, no real content.
node --experimental-strip-types tools/anonymise.ts \
  --in design/budget-data.js --out db/fixtures/anonymised.json
SEED_MODE=anonymised npm run db:seed
```

The anonymiser discards entity codes, entity names, every line name and all free
text; jitters amounts ±7% and rounds them; and shuffles order so position
carries no information. What survives is the shape — 21 entities, 486 lines,
the real currency mix and phasing — which is what makes performance and
reconciliation work meaningful.

**Read its k-anonymity report.** On the real workbook it says 16 of 21 entities
remain unique on (currency mix, category count, size band). The output is
therefore **pseudonymous, not anonymous**: still personal data under GDPR
Recital 26 for anyone able to single out a subject. It is a legitimate
`Internal` development fixture, it is gitignored, and it should not be called
anonymous in a RoPA without Legal agreeing. `loadConfig` refuses any mode but
`synthetic` in production.

## Admin operations (ADR 0005)

The **Operations** view, visible to Admin only:

- **Run backup** — every table except live sessions, gzipped JSON Lines,
  encrypted with AES-256-GCM. The manifest records row counts, a SHA-256 of the
  ciphertext, and whether `audit_verify_chain()` verified at capture time, so a
  restore can be trusted or questioned on evidence. Without
  `BACKUP_ENCRYPTION_KEY` the API refuses rather than writing plaintext.
- **Export consolidation** — the existing `FR-064` XLSX export, with the
  formula-injection guard on every text cell.

Both require `backup.run` / `backup.download`, both are step-up capabilities
(ZT-007) so a stale session is asked to re-authenticate, both are rate limited,
and both are audited with counts for the ZT-008 mass-export alert.

**Restore** is implemented and round-trip tested (`npm run restore`), but it is
a command-line tool rather than a button. It truncates `audit_events`, which the
application role cannot do by grant and the append-only trigger would refuse
anyway — an endpoint would mean granting the running service the right to erase
its own audit trail, which is the capability the trail exists to deny.

What the Operations view does offer is **verify**: decrypt the most recent
archive, parse it and reconcile it against its manifest, writing nothing. Safe
to run against production on a schedule, which is what makes "we have a restore
path" checkable rather than asserted.

`CMP-107` still needs a published RTO/RPO. The mechanism works; the commitment
is the organisation's.

**Backups must be written to shared storage.** The Bicep runs a minimum of two
replicas, and `BACKUP_DIR` used to point inside the container: the manifest is
in the database and shared, the ciphertext was on one replica's disk, so
download and verify were a coin flip and a restart destroyed the archive. The
environment now mounts an Azure Files share at `/var/backups`, and the self-test
refuses to call a path shared unless it is genuinely a mount point — a check
that fails in production and warns elsewhere, because the previous
`backup.readable` check ran *inside* a replica and passed on whichever one
happened to hold the file.

## Scenarios and driver trees (ADR 0007)

`FR-080` is built. `budget_version` was a free-text column from day one, exactly
as SPEC §11 asked; migration 008 turned it into a table with a key, a kind, a
lock and a foreign key from every amount.

The **Scenarios** view lists the versions for the cycle and compares any of them
against the working plan. A version is copied from another in one statement, a
forecast is rebased from actuals for the periods that have closed, and a locked
version refuses every write **at the table** — the trigger is the control and
the handler check only produces a better message.

A version is group-wide, and `version.manage` is held by the Administrator and
the CFO. Reading is open to anyone who can already read across entities; the
figures inside a scenario go through the same scope resolver as every other
report, so a manager sees their own entities in both sides of a comparison.

`FR-020` driver trees: a driver is either typed in or defined as a **sum of
terms** over other drivers — `devices = 1.5 per head + 2 per site`. The resolved
figure is stored, so every read path is unchanged; the resolver refuses a cycle
before the transaction commits, and the self-test re-derives every derived
driver against its definition.

The sum is rounded **once**, not per term. Rounding each term would accumulate
half a unit of error per term, so a three-term definition could land a unit away
from the figure a finance manager computes by hand — and that figure is the one
this has to match.

A term is a row, not an expression: `{ source, factor }`. Nothing is parsed and
nothing user-supplied is interpreted, so this does not reopen ADR 0007's
argument against a formula engine. The **Drivers** view edits them, shows a
derived driver read-only beside its definition, and reports what a change moved
downstream (FR-021's blast radius, stated rather than implied).

**There is no formula engine, and that is a decision rather than a backlog
item** — [ADR 0007](docs/adr/0007-modelling-depth.md) sets out why. Short
version: a user-authored expression language is an interpreter for untrusted
input in a codebase whose whole SQL and validation story is "nothing supplied is
ever interpreted", and it is a second definition of every number that no test
and no review ever sees.

## Self-test (row 14)

Eighteen read-only checks against the live database — audit chain and anchor,
the financial invariants over real rows, whether the latest backup can still be
read, whether the retention job is running. Three ways in:

```bash
npm run selftest                       # in-process, no running service needed
curl .../api/admin/self-test           # the endpoint, admin or CFO
ops/selftest/Invoke-SpendifreSelfTest.ps1 -BaseUrl https://…
```

Distinct from `npm test`, and the distinction is the point: the test suite
proves the code is right against a throwaway database, and this proves the data
is sound in the one someone is using. A system can pass either and fail the
other.

## Reporting performance (NFR-001)

```bash
npm run loadtest      # amplifies to monthly × 3 versions, then measures
```

Worst p95 **195 ms** against a 300 ms budget, 171 requests a second across six
report routes at twenty concurrent readers. It was 557 ms and 88 a second.

The fold from period rows to line totals runs in the database, and the reports
that show aggregates group there too. What made the difference was not the query
plan — `explain analyze` was already sub-millisecond — but the row count
crossing into JavaScript: the consolidation was parsing 588 line rows into
`Money` objects to render 29 numbers.

`computeLineTotals` is still there as the readable definition of what a line's
total is, and `test/invariants.test.ts` asserts the SQL agrees with it over the
whole seeded dataset, in five years, with headcount planning on and off, and on
driver-linked lines specifically. That test is the reason the refactor was safe
to do; it failed the first time it ran and was right to.

## Three things worth knowing

**The application never reads the real workbook.** `design/budget-data.js` is
the FY2026 extract: live vendor names, contract values, and named individuals in
the training lines. Only `tools/anonymise.ts` reads it, offline; a CI gate fails
the build if anything under `packages/` or `test/` references it. See
`docs/osint-exposure.md`, which is the most important document here.

**Mutation testing, and it found six real gaps.** Line coverage says a line
ran; it does not say an assertion depended on it. `npm run mutate` changes one
operator at a time in `packages/shared` — a `<` to a `<=`, an `&&` to an `||`,
a `true` to a `false` — and re-runs the shared suite against each. On the first
pass 17 mutants survived, across six validators: the `Money` range boundary,
the control-character guards in `shortText` and `longText`, the decimal-scale
bound, the negative-rate refusal, the percentage limits and the driver-factor
limits. Every one was a line the suite executed and nothing asserted about.
All are now covered, and the score is 100% of 73 mutants.

It is not Stryker, for the reason `tools/loadtest.ts` is not k6 (ADR-0004). The
hard part is a TypeScript parser, and `typescript` is already a dev dependency;
the loop around it is a hundred lines. The trade is real — no incremental mode,
no coverage-based test selection — and it is why the run is nightly and why
`test/shared.test.ts` has no database fixture: the suite runs once per mutant,
so a ten-second fixture would have cost hours. The money assertions moved there
out of `invariants.test.ts`, where they sat behind a fixture they never used.

Four mutants cannot change behaviour — widening `numerator < 0n` to `<= 0n`
flips the sign of a zero — and are marked in the source with the operator and
the reason. They are reported every run and excluded from the score rather than
folded into it, and a marker that stops matching a live mutant fails the run:
the same treatment `EXCLUDED_FROM_BACKUP` gets, because a stale exemption is
how a real gap gets silenced later.

**A published template version is immutable in the database now, not only in
the route.** Migration 005's header said a CHECK enforced it. It did not: the
CHECK constrains the publisher and timestamp columns, and the two guards in
`routes/template.ts` were the whole mechanism. Those guards are correct and
tested, but `spendifre_app` holds UPDATE and DELETE on `template_fields`, so a
future code path that forgot one would rewrite a frozen template — the template
an already-approved budget was filled in against — with nothing objecting.
Migration 012 adds statement-level triggers refusing writes to a published
version's fields and any change to the version row itself, including
unpublishing it. 005 cannot be edited, because the runner records its checksum
and refuses a changed file, so the correction is a mechanism rather than a
comment. The seed now creates the version as a draft, adds the fields, and
publishes it — the route an administrator takes, rather than a shortcut only
the seed can use.

**Residency is enforced in one place, and it is three settings.**
`RESIDENCY_REGION` is where the deployment runs — one value, because a backup
archive is bound to it by the AES-GCM AAD. `SERVED_REGIONS` is which residency
buckets it may show — a list, defaulting to the home region alone.
`SERVED_COUNTRIES` narrows within those buckets and is unset by default. The
single scope resolver applies the caller's read scope and the served scope
together, so an entity outside it returns 404 even to an administrator.

The third setting exists because a bucket is not a jurisdiction: `apac` covers
Singapore, India and Vietnam, so the model could not express "serve Singapore
but not Vietnam". `entities.country` records the fact and `residency` is derived
from it by a composite foreign key to `countries`, which is what stops the two
becoming independent opinions about the same entity. The bucket stays on the row
because it is the hot predicate in the reporting fold; the foreign key is what
makes keeping it safe. Both dimensions resolve through one fragment,
`servedEntityClause`, rather than being written out per query — two conditions
copied across twenty call sites is the omission that produced the
consolidation-report leak, with more surface.

They were one setting until the group chose a central deployment, and the
conflation made that choice unimplementable: it served 14 of 21 entities and
made the other 7 invisible to everyone, because "where we run" was answering
"whose data may we show". Splitting them changed the control's arity, not the
control — still an allow-list, still one place, still closed by default.

None of that makes the group PIPL-compliant. Choosing central hosting *removes*
the arrangement in which nothing crossed a border, so every non-EU jurisdiction
now needs a lawful basis before its region is declared (`SPEC.md` §12.1).

**Bugs the tests found while building.** Worth recording because they are the
argument for the tests existing: the FX rate schema capped rates at 4 decimal
places against a `numeric(18,8)` column, which made VND, LAK and KRW
unadministrable — and it did so by *throwing inside a Zod refine*, turning a
422 into a 500. The residency filter was initially applied only to the entity
list, so the consolidation report summed Swiss and Chinese entities into a EUR
total. Framework-level 4xx errors were being reported as 500.

**A NUL byte in a source file** made `routes/ledger.ts` binary. It worked — NUL
is a fine map-key separator and no `ledger_ref` can contain one — and it made
the file invisible to `grep`, to `git diff` and to every review tool. That is
not hypothetical harm: a repository-wide refactor of the residency filter
skipped that one file silently, and the ledger ingest went on filtering by the
old setting while every other route moved. It is an escape now, CI refuses
control characters in source, and the gate is enforced with Perl because GNU
`grep -P` cannot match a NUL and the obvious version of the check passed on the
very file it was written for.

**The audit trail was not scoped by residency.** `audit.viewAll` means every
actor's events, not every region's — but the query had no region filter, so an
administrator could read the detail of an event about an entity the
consolidation report correctly refuses to show, and those details carry entity
codes, line names and amounts. Same failure as the original consolidation bug,
in the one place it is hardest to notice, because an audit list looks complete
whatever it omits.

The most recent came from the NFR-001 work: **the seed was drifting the EUR
rate**, writing 0.94 EUR per EUR for FY2022 so that FR-063's volatility chart
would look interesting. Nothing caught it because `loadFxTable` overrides EUR to
1 after reading the table — the read path was compensating for a fixture that
was wrong. It surfaced the moment a second implementation of the same
conversion read the row instead. Both are fixed: the seed no longer drifts EUR,
and the SQL pins it the same way the loader does.

All fixed, all now covered.

## Not done

Stated plainly rather than left to be discovered.

- **A live ledger feed.** `FR-040` is built — `POST /api/ledger/actuals` takes a
  batch, is idempotent on the feed's own reference, stores rejects rather than
  dropping them, and refuses hand edits to periods it owns. **Nothing is
  connected to it.** The contract exists; which finance system speaks it, and on
  what schedule, is still open (`SPEC.md` §12.3).
- **A service principal for that feed.** `ledger.ingest` is admin-only today
  because there is no non-human identity. A scheduled job cannot satisfy the
  step-up requirement, which is why the capability is deliberately not a step-up
  one; the compensating controls are in `shared/authz.ts`.
- **A restore button.** Restore itself is built and round-trip tested against
  two real databases (`npm run restore`), but it is a command-line tool: it
  truncates `audit_events`, and an endpoint would mean granting the running
  service the right to erase its own audit trail. What is still missing is the
  published RTO/RPO backed by a timed drill (`CMP-107`).
- **Screens for the FR-051 stage configuration and FR-005 template versions.**
  Both are complete APIs with tests; an administrator drives them over HTTP
  today. Stage progress is readable per submission; there is no drag-to-reorder
  UI, and the reorder endpoint takes a whole list precisely so there need not
  be. FR-020 driver definitions had the same gap and now have a screen.
- **Entra ID against a live tenant.** The OIDC client is written to spec —
  authorisation code with PKCE S256, server-side single-use `state` and `nonce`
  held in `auth_transactions`, discovery-driven metadata, and signature, issuer,
  audience and nonce validation delegated to `openid-client` rather than
  hand-rolled. It has never been pointed at a real tenant, so
  treat first connection as an integration task with real findings in it
  (group-to-role mapping and `amr` values in particular).
- **Deployment.** There is now a container image, Bicep for the whole
  environment, and a release pipeline that signs and attests what it builds —
  but none of it has been applied to a subscription. It is unproven in the same
  way the Entra client is.
- **A SIEM subscribed to the alerts.** The metrics, traces and the three ZT-008
  rules all exist (`ops/alerts/`). Nothing ingests them yet, so a broken audit
  chain is still found by someone looking rather than by a page.
- **A penetration test** (`SEC-041`). The DAST stage is not a substitute: it
  runs with DEV_AUTH on so the scanner can get past the front door.
- **A formula engine.** Named rather than omitted: it is the one item from the
  modelling-depth row that was not built, and ADR 0007 says why it should not
  be. Listed here so it is a decision on the record rather than an absence
  somebody rediscovers.
- **A native-speaker review of the translations.** `NFR-010` is met and there
  are six catalogues — English, Swedish, Norwegian, Danish, Finnish, French —
  each persisted per user and asserted against the English key set. None has
  been read by a native speaker, and each file says so at the top. That is a
  translation review, not an engineering task.
- **Assistive-technology testing.** axe passes on all 12 views in a real browser
  and the palette is asserted arithmetically, but no screen-reader user has used
  this. `docs/vpat.md` marks exactly which claims are code-reading rather than
  verified.

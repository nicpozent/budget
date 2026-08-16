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
docs/adr           five decisions with their reasoning
docs/user-guide    per-role guide, every feature, with screenshots
SoW/               statement of work and the 28 flow diagrams
test/              362 tests: authorisation matrix, security, invariants, a11y, operations
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

Inside `packages/api`, `src/` is split by technical layer
(`routes`/`services`/`http`/`db`/`auth`) rather than by feature. At this size
that keeps the security-relevant code in three files someone can review in one
sitting — `http/guard.ts`, `db/pool.ts`, `services/audit.ts`. If the domain grows
past what one person can hold, feature slices under `src/features/` would be the
next move; it is not worth the churn yet.

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

Restore is deliberately **not** implemented — an untested restore path invites
false confidence. `CMP-107` needs a tested RTO/RPO.

## Three things worth knowing

**The application never reads the real workbook.** `design/budget-data.js` is
the FY2026 extract: live vendor names, contract values, and named individuals in
the training lines. Only `tools/anonymise.ts` reads it, offline; a CI gate fails
the build if anything under `packages/` or `test/` references it. See
`docs/osint-exposure.md`, which is the most important document here.

**Residency is enforced in one place.** Every entity carries a region; the
deployment carries its own. The single scope resolver applies both the caller's
read scope and the region filter, so an EU deployment returns 404 for a
mainland-China entity even to an administrator. That does not make the group
PIPL-compliant — it makes the code ready for whichever topology Legal picks
(`SPEC.md` §12.1), and removes the failure mode where a misrouted replica
quietly serves data across a border.

**Bugs the tests found while building.** Worth recording because they are the
argument for the tests existing: the FX rate schema capped rates at 4 decimal
places against a `numeric(18,8)` column, which made VND, LAK and KRW
unadministrable — and it did so by *throwing inside a Zod refine*, turning a
422 into a 500. The residency filter was initially applied only to the entity
list, so the consolidation report summed Swiss and Chinese entities into a EUR
total. Framework-level 4xx errors were being reported as 500. All fixed, all
now covered.

## Not done

Stated plainly rather than left to be discovered.

- **`FR-040` ledger integration.** Actuals are hand-recorded. The `actuals.source`
  column already distinguishes `manual` from `ledger` and refuses hand edits to
  ledger-owned periods, so the cutover is a feed, not a migration.
- **`FR-005`** template versioning — in-flight budgets keeping their version.
- **`FR-033`** next year's depreciation flowing into that year's opex plan. The
  schedule is computed; the flow-through is not wired.
- **`FR-051`** configurable approval stages. States and transitions exist;
  reorderable stages with role and threshold conditions do not.
- **Restore from a backup.** The archive format is documented and line-oriented
  so a restore can stream it, but nothing reads it back. `CMP-107`.
- **`FR-061` trend / `FR-063` FX history / `FR-036` allocations** have API
  endpoints and are tested, but no dedicated screen — the client covers entry,
  actuals, variance, consolidation, submissions, cost centres, audit and
  governance. The remaining screens are view work against existing endpoints.
- **`FR-080`** versions and scenarios remain deferred as the spec instructs, but
  amounts are addressable by `(line, fiscal_year, period, budget_version)` from
  day one, so adding the dimension is a data migration.
- **Entra ID against a live tenant.** The OIDC client is written to spec —
  authorisation code with PKCE S256, server-side single-use `state` and `nonce`
  held in `auth_transactions`, discovery-driven metadata, and signature, issuer,
  audience and nonce validation delegated to `openid-client` rather than
  hand-rolled. It has never been pointed at a real tenant, so
  treat first connection as an integration task with real findings in it
  (group-to-role mapping and `amr` values in particular).
- **Deployment:** no Bicep/Terraform, no SIEM wiring, no DAST run, no
  penetration test (`SEC-041`). The CI workflow defines the gates.
- **`NFR-010`** strings are not externalised; formatting is locale-aware, the
  copy is not.

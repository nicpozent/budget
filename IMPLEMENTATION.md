# Spendifre — implementation

The design bundle described in `README.md` is now built. `SPEC.md` remains the
contract; this file explains what exists, how to run it, and — most usefully —
what is **not** done.

```
packages/shared    money, the SPEC §5 permission matrix, domain types, boundary schemas
packages/api       Fastify API, auth, authorisation, audit, reporting, export
packages/web       React client, design tokens, accessible grid
db/migrations      schema, append-only audit, least-privilege roles
docs/adr           four decisions with their reasoning
docs/security      threat model (STRIDE + ATT&CK), NIST/Zero Trust, OSINT assessment
docs/compliance    NIS2, GDPR/revFADP, APAC/PIPL position
test/              313 tests: authorisation matrix, security, invariants, accessibility
```

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
| `ZT-001`–`ZT-008` Zero Trust | `auth/session.ts`, `http/guard.ts`; see `docs/security/nist-and-zero-trust.md` |
| `FR-070`–`FR-073` audit | Append-only by grant **and** trigger **and** SHA-256 hash chain |
| `A11Y-001`/`A11Y-002` | axe against the running app in a real browser, plus contrast maths over the palette |

## Three things worth knowing

**The seed is synthetic, deliberately.** `budget-data.js` is the real FY2026
workbook: live vendor names, contract values, and named individuals in the
training lines. `PRIV-010` forbids it as a fixture, so the seed reproduces its
*shape* — 21 entities, 8 categories, ~590 lines, five years of history — with
invented names. A CI gate fails the build if application code imports it. See
`docs/security/osint-exposure.md`, which is the most important document here.

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
- **`FR-061` trend / `FR-063` FX history / `FR-036` allocations** have API
  endpoints and are tested, but no dedicated screen — the client covers entry,
  actuals, variance, consolidation, submissions, cost centres, audit and
  governance. The remaining screens are view work against existing endpoints.
- **`FR-080`** versions and scenarios remain deferred as the spec instructs, but
  amounts are addressable by `(line, fiscal_year, period, budget_version)` from
  day one, so adding the dimension is a data migration.
- **Deployment:** no Bicep/Terraform, no SIEM wiring, no DAST run, no
  penetration test (`SEC-041`). The CI workflow defines the gates.
- **`NFR-010`** strings are not externalised; formatting is locale-aware, the
  copy is not.

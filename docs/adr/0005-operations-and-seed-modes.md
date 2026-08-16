# ADR 0005 — Seed modes, admin backup, and two capabilities SPEC §5 does not have

**Status:** Accepted · **Drivers:** PRIV-010, CMP-104, CMP-107, ZT-006, ZT-007, ZT-008

## Context

Three requests, all touching the same nerve: moving the dataset around safely.

1. Anonymise the real workbook and make the seed choice a deployment option.
2. Let an administrator trigger a backup.
3. Let an administrator trigger an export.

## Decision 1 — anonymisation is an offline tool, not an application feature

`tools/anonymise.ts` reads `design/budget-data.js` and writes
`db/fixtures/anonymised.json`. The API and the seeder never read the raw
extract; they read the artefact.

That separation is the whole point. It makes "did production data reach a
non-production database?" a question with a single checkable answer, and it lets
the CI gate keep refusing any import of `budget-data` from `packages/` or
`test/` without carving out an exception that would erode.

**`SEED_MODE` selects the dataset**, `synthetic` (default) or `anonymised`. Both
converge on a `Dataset` before anything touches the database, so there is one
loader and the modes cannot drift in what they exercise. Production refuses any
mode but `synthetic` at startup — seeding a production database from a fixture
is a mistake regardless, and the anonymised one is still *derived* from real
data.

### Why anonymise at all, when a synthetic seed exists

Shape. The real workbook's distribution of lines across entities and categories
is lumpier than any generator produces, and that unevenness is what makes
NFR-001 performance work and the INV-4 reconciliation property meaningful. The
synthetic seed gives every entity the same tidy structure; the real one does not.

### What the tool actually does, and what it does not

It closes four re-identification routes and is explicit about the fourth:

- **Direct identifiers** — entity codes, entity titles and every line name are
  *discarded*, not pseudonymised. The source line names embed vendor names
  (`Partner <vendor>`) and, in the Training category, the given names of
  identifiable employees. A stable pseudonym would still support linkage.
- **Quasi-identifiers** — an exact contract value identifies a supplier to
  anyone who knows the market. Amounts are jittered (±7% by default) and then
  rounded. Both steps: jitter alone leaves a near-match, rounding alone is
  reversible if the original granularity is known.
- **Positional linkage** — entities and lines are shuffled, or every mitigation
  above would be undone by counting rows.
- **Singling out by structure** — an entity unique on (currency mix, category
  count, size band) is identifiable from shape alone. The tool cannot fix this
  without destroying the utility it exists to preserve, so it **reports** it.

On the real workbook, **16 of 21 entities are structurally unique**. That is
the honest headline: the output is **pseudonymous, not anonymous**, in GDPR
terms — it remains personal data under Recital 26 for anyone with the means to
single out a data subject. It is a legitimate `Internal` development fixture. It
is not publishable, and it should not be described as anonymous in a RoPA
without Legal agreeing.

By default the keying material is random per run and discarded at exit, so no
mapping back to the source exists anywhere. `--key` makes a run reproducible at
the cost that whoever holds the key can relink it; the default is the safe one.

The output deliberately contains **no digest of the source**. A fingerprint
would let someone confirm a guess about which workbook it came from — the same
disclosure by a longer route.

## Decision 2 — backup as an audited, encrypted, chain-attesting operation

`POST /api/admin/backups` dumps every table except live sessions to gzipped
JSON Lines, encrypts it with AES-256-GCM, writes it to `BACKUP_DIR`, and records
a manifest row.

Design points that are not obvious:

- **Encrypted at rest, key from the environment.** A deployment without
  `BACKUP_ENCRYPTION_KEY` refuses to create a backup rather than writing
  plaintext. Failing is better than a quiet unencrypted copy of everything.
- **AAD binds the ciphertext to `(backup id, region)`.** A blob moved between
  manifests, or restored into the wrong region, fails to decrypt instead of
  quietly succeeding (CMP-140).
- **The manifest records `audit_verify_chain()` at capture time.** A backup that
  caught a broken chain is evidence of *when* it broke. Without that field it is
  just a file. This is the part that makes backups useful for `CMP-150` rather
  than only for recovery.
- **Sessions and auth transactions are excluded.** They are live credentials,
  not records; archiving them would outlive the sessions for no restore value.
- **Tables come from a fixed allow-list, not `information_schema`.** A new table
  is absent from backups until someone adds it here — a failure that gets
  noticed, rather than an unreviewed table silently exported.
- **Integrity is checked before decryption** (SHA-256 of the ciphertext) and
  during it (GCM auth tag), so a modified archive fails twice rather than
  yielding partially-trusted plaintext.

## Decision 3 — two new capabilities, and why §5 changed

SPEC §5 has no operations row. SPEC §0 says *"never widen a role's permissions
without changing §5 in the same commit"*, so this ADR is that change:

| Capability | Admin | CFO | Everyone else |
|---|---|---|---|
| `backup.run` | ✓ | — | — |
| `backup.download` | ✓ | — | — |

Both are in `STEP_UP_CAPABILITIES`. A backup is a complete copy of the dataset
and a download moves it outside the system boundary; a session left open all
afternoon should not be enough (ZT-007). Both are rate limited harder than
anything else, because repeated backups are the shape of a slow exfiltration,
and both are audited with row counts so the `ZT-008` mass-export alert has
something to threshold on.

The export already existed under `budget.view.any` (`FR-064`); it needed a way
to reach it, not a new permission. The Operations view surfaces both.

## Consequences

- A backup is a plaintext copy of personal data once decrypted. It inherits the
  RoPA and a 24-month retention entry, and `docs/compliance` says so.
- `BACKUP_DIR` is a local path in this implementation. Production should be a
  Blob container with customer-managed keys and an immutability policy;
  encryption here means a local misconfiguration is not immediately a breach.
- Restore is **not** implemented. The archive format is documented and
  line-oriented so a restore can stream it, but nothing reads it back into a
  database yet. `CMP-107` needs a tested RTO/RPO, and an untested restore path
  is worse than an absent one because it invites false confidence.

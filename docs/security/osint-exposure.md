# OSINT and information-exposure assessment

What a motivated outsider could learn about Birgma / Biltema Group IT from
material this project produces or publishes, and what has been done about it.
Open-source intelligence is reconnaissance: most of it is not a vulnerability on
its own, but it shortens the path to one.

---

## 1. Finding: real commercial data is in the repository

**This is the most significant exposure in the project, and it is not a
code defect.**

`budget-data.js` at the repository root is not seed data. It is the FY2026
workbook extract: 21 entities, 486 line items with quarterly plans, the FX
table, and a `comments` array. It contains:

- **Live vendor and partner names** — the consultancy, connectivity and
  licensing suppliers the group actually uses, with the annual value of each
  relationship. This is enough to reconstruct the group's supplier map and its
  negotiating position at renewal.
- **Named individuals.** The Training category carries lines of the form
  `Training <first name>` for at least five people, each with a budgeted amount
  and quarterly phasing. That is personal data about identifiable employees,
  linked to spend.
- **Free-text commercial detail** in `comments`, including contract terms
  ("signed for 3 years, paid annually"), stated intent to evaluate alternatives
  to a named vendor, and dated USD figures.

`SPEC.md` `PRIV-010` classifies this as `Confidential` and states it "must not
go into a public repo or a shared test fixture". `CMP-104` (ISO 27002 A.8.31)
prohibits production data in non-production environments.

**What the implementation does about it:**

- The seed (`packages/api/src/db/seed.ts`) is **entirely synthetic**. It
  deliberately does not read `budget-data.js`. It reproduces the *shape* — 21
  entities, the same eight categories, comparable line count and currency
  spread, five years of history — so that performance work (`NFR-001`) and the
  reconciliation property tests (`NFR-004`) run against realistic volume without
  putting real commercial or personal data into a development database.
- Vendor names in the fixture are drawn from Microsoft's standard fictional
  companies (Contoso, Fabrikam, Northwind…), which are unambiguously not real
  suppliers.

**What still needs a human decision (outside this codebase):**

1. Confirm the repository hosting `budget-data.js` is private and
   access-controlled. If it has ever been public, treat it as disclosed: vendor
   relationships and the named training lines are out.
2. Decide whether the file should live in the application repository at all. It
   is an input to a migration, not a build artefact. A one-time load from
   controlled storage is the safer pattern.
3. The named training lines are personal data. They need a lawful basis and an
   entry in the record of processing (`CMP-130`), or the names should be
   replaced with role references before the data is loaded anywhere.
4. If the file is removed, remember that git history retains it. Removal is a
   history rewrite plus a credential-style rotation of the assumption that the
   data was private.

---

## 2. What the running application discloses

Deliberately checked, because an application's default behaviour leaks more than
its documentation.

| Surface | Leaks? | Control |
|---|---|---|
| HTTP response headers | No | `X-Powered-By` removed; no framework or version banner |
| Error responses | No | One safe message per error code. No stack traces, SQL text, driver messages, table names or internal identifiers. Tested. |
| Validation errors | Field name and our own message only | Zod issue objects are never serialised — they can echo the received value, which turns an error into a reflection surface. Tested with a marker string. |
| Authentication failures | No | Unknown account, failed nonce, and missing role group are all reported identically — the caller cannot enumerate who has an account or who holds a role |
| Object identifiers | No | Opaque UUIDv4. Out-of-scope reads return 404, so status codes cannot be used to test for existence |
| Source maps | Not shipped | `sourcemap: false` — a source map is a free map of the application |
| Login page | Names Entra ID | Acceptable and unavoidable: the sign-in redirect discloses the IdP regardless. It does not disclose tenant membership or valid addresses. |
| `/healthz` | Status only | No version, no dependency status, no build identifier |

## 3. What the *repository* discloses to a reader

Assuming an attacker reads the code (or it becomes public):

| Item | Assessment |
|---|---|
| The permission matrix | Public knowledge of the rules is fine — the enforcement is server-side and tested. Kerckhoffs applies. |
| Entra group names (`SG-Spendifre-*`) | Low value alone; useful for a social-engineering pretext. Acceptable; they are operational names, not secrets. |
| Entity codes and organisational structure | Present in the synthetic seed only. Real codes are in `budget-data.js` — see §1. |
| Database schema | Discloses no secret. Knowing the audit table is hash-chained is a deterrent, not a weakness. |
| Secrets | None. No secret has a default value, `loadConfig` refuses to start without them, and there is no credential, token or connection string in source. Local development uses an obviously-labelled throwaway password supplied out of band. |
| `.env.example` | Names variables, holds no values |

## 4. Wider OSINT surface (outside this repository)

Recorded here because the threat model is incomplete without it, even though
none of it is fixed by code:

- **Job adverts and staff profiles.** Postings naming Entra ID, Azure Sweden
  Central, or specific finance systems tell an attacker the stack and hint at
  version. Worth a periodic review with HR.
- **Certificate transparency logs.** Any hostname issued a public certificate is
  enumerable by anyone. Assume `spendifre.<domain>` is discoverable and do not
  rely on an unguessable hostname for anything.
- **DNS and mail records.** SPF/DMARC/DKIM should be strict; a permissive DMARC
  policy makes the phishing route in §T1566 materially easier, and phishing is
  the highest-likelihood initial access for this application.
- **Breach corpora.** Reused credentials from unrelated breaches are the
  standard precursor to account takeover. Phishing-resistant MFA on privileged
  roles is what makes that a non-event here.
- **The vendor list itself.** Once known (see §1), suppliers become a
  supply-chain and pretexting route — "your Be-Terna invoice" is a convincing
  phish to someone who owns that budget line.

## 5. Recommendations, in priority order

1. Confirm the repository's visibility and remove `budget-data.js` from it if it
   is not strictly private. Treat prior public exposure as a disclosure incident.
2. Replace the named training lines with role references before that data is
   loaded into any environment, or record the lawful basis in the RoPA.
3. Keep the synthetic seed as the only fixture. It is already the default;
   the point is not to "temporarily" load the real extract for a demo.
4. Enforce strict DMARC and run phishing simulation for the roles that hold
   `submission.decide` and `governance.edit`.
5. Add secret scanning to CI (configured — see `.github/workflows/ci.yml`) and
   run it over full history, not just the diff.

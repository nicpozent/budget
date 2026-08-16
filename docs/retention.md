# Data retention & erasure

Retention is **enforced by a job that audits its own counts**, not by a policy
document. `PRIV-001` is explicit: "retention that is documented but not executed
is a finding".

---

## How it works

Periods live in the `retention_policies` table, editable by Admin and CFO only
(`governance.edit`, a step-up capability) and audited on every change
(`PRIV-002`). Defaults come from `SPEC.md` §9.2:

| Dataset | Default | Basis |
| --- | --- | --- |
| `audit` | 84 months | ISO 27001 A.8.15 |
| `budget` | 120 months | Statutory accounting |
| `free_text` (comments, justifications, information requests) | 36 months | GDPR Art. 5(1)(e) |
| `inactive_users` | 24 months | GDPR / revFADP |
| `backups` | 24 months | Operational |

## 1. Age-based retention (automatic)

`POST /api/governance/retention/run` executes a pass and writes one audit event
with the counts purged. Schedule it nightly.

- **Free text** older than its period is deleted.
- **Inactive users** past their period are deactivated; their sessions end at
  the next request.
- **Audit events** are the interesting case — see below.

### The audit conflict, and how it is resolved

`FR-073` says audit entries are "never editable or deletable, by anyone,
including admins". `PRIV-001` says enforce 84 months. Both are right, and they
conflict. The resolution:

1. The application role holds **no `DELETE`** on `audit_events`.
2. The trigger refuses `DELETE` unless a session GUC is set **and** the row is
   past its configured retention — so even a leaked GUC cannot purge recent
   history.
3. Only `audit_purge_expired()`, a `SECURITY DEFINER` function granted solely to
   `spendifre_retention`, can set that GUC.
4. After purging it **re-anchors the hash chain** to the surviving head, so
   verification still starts from a recorded value instead of failing forever.

## 2. Right to erasure (on request)

`POST /api/governance/subject/:userId/pseudonymise` — Admin or CFO, step-up
required, audited.

**Erasure must not break the audit chain**, so it pseudonymises rather than
deletes:

| Data | Action |
| --- | --- |
| Email | Replaced with `erased+<uuid>@invalid.example` |
| Display name | Replaced with `Erased user` |
| Entra object id | Cleared, so the account cannot be re-linked |
| Account | Deactivated; every session revoked immediately |
| Free text authored by the subject | Deleted |
| **Audit events** | **Retained.** They still exist, still hash-link, and still prove who approved what — they simply no longer identify a person. |

Deleting the audit rows instead would break both the chain and the statutory
accounting record (`CMP-133`, `CMP-151`).

`GET /api/governance/subject/:userId/export` serves access and portability. It
returns the person's own records — user row, their comments, their audit
entries — and deliberately **not** the budget figures they touched, which are
commercial data belonging to the group rather than personal data belonging to
them.

## Configuration

```bash
# Nightly, as the retention role — not the application role.
0 2 * * *  psql "$RETENTION_DATABASE_URL" -c "select audit_purge_expired();"
```

The API endpoint covers free text and inactive users; the audit purge is a
separate database call because it runs under a different role by design.

## Verification

```sql
select dataset, months, updated_at from retention_policies order by dataset;

select occurred_at, detail from audit_events
where action = 'governance.retention.run' order by seq desc limit 10;
```

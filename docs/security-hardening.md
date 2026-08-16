# Security hardening

Practical controls that reduce what an attacker who reaches the environment can
do. Most of the application-layer controls are already in the code and covered
by tests; the items here are the ones that live in **deployment and database
configuration**, plus the settings the application exposes for you to turn on.

> **Threat model reminder.** Administrator access to Spendifre goes *through the
> app* — authorised, scoped, step-up-protected and audited. The controls here
> target the **bypass path**: someone reaching the database, the backup volume
> or the host directly. That access is invisible to Spendifre's audit log, so it
> has to be defended at the database and infrastructure layers.

See also [`secrets.md`](./secrets.md), [`postgres-cert-auth.md`](./postgres-cert-auth.md),
[`observability.md`](./observability.md) and the [threat model](./threat-model.md).

---

## 1. Encryption in transit (app → database) — TLS

`node-postgres` **does not negotiate TLS unless asked**, so this is explicit
configuration, not a default you can rely on. Spendifre reads `DB_SSL_MODE`:

| Value | Behaviour |
| --- | --- |
| `disable` | Plaintext. Only for a local container with no certificate. **Refused in production at startup.** |
| `require` | Encrypt, do **not** validate the certificate. Stops a passive listener; does nothing about an active man in the middle. |
| `verify-full` | Encrypt **and** validate the chain and hostname. The only mode that defends the path an attacker on the network segment would actually take. |

```bash
DB_SSL_MODE=verify-full
DB_CA_CERT=/etc/ssl/certs/db-ca.pem   # or the PEM inline
```

- **Azure Database for PostgreSQL** requires TLS by default and chains to a
  public root, so `verify-full` works with no `DB_CA_CERT`.
- **Local container**: stock `postgres:16` has no certificate — leave
  `DB_SSL_MODE=disable`, or mount a cert and follow
  [`postgres-cert-auth.md`](./postgres-cert-auth.md).

A test asserts that production refuses `disable`. It was added because the first
implementation of this codebase connected in plaintext without anyone noticing —
the default is silent, which is exactly why it needs a gate.

## 2. Least-privilege database roles

`db/migrations/003_roles_and_grants.sql` creates three roles, because they have
three different jobs:

| Role | Holds | Does not hold |
| --- | --- | --- |
| `spendifre_migrator` | Schema ownership, DDL | — (used only by migrations) |
| `spendifre_app` | DML on business tables; `SELECT, INSERT` on `audit_events` | **No DDL. No `UPDATE`/`DELETE` on audit. No `CREATE` on schema.** |
| `spendifre_retention` | `EXECUTE` on `audit_purge_expired()` and little else | Everything else |

The migration also strips the implicit `PUBLIC` grant before adding anything
back, so the starting position is deny.

**Keep a separate DBA account** for maintenance and break-glass. Least privilege
applies to the application's runtime role, not to your operators.

Verify after deployment:

```sql
-- Should return zero rows.
select grantee, privilege_type from information_schema.role_table_grants
where table_name = 'audit_events' and grantee = 'spendifre_app'
  and privilege_type in ('UPDATE','DELETE');
```

## 3. Encryption at rest

| Layer | Control |
| --- | --- |
| Database | Azure Database for PostgreSQL is encrypted at rest by default; choose **customer-managed keys** in Key Vault for `Confidential` data. Community Postgres has no TDE — use volume encryption (LUKS / BitLocker). |
| Backups | Encrypted **by the application** with AES-256-GCM before the bytes reach storage, so platform encryption is defence in depth rather than the only control. Without `BACKUP_ENCRYPTION_KEY` the API refuses to create a backup rather than writing plaintext. |
| Session tokens | Never stored. Only `sha256(token)`, so a database read yields nothing usable. |
| IP / user-agent | Salted SHA-256 only — enough to detect session relocation, not enough to rebuild a browsing history. |
| Blob container | Enable **immutability (WORM)** on the backup container. A backup an attacker can delete is not a recovery control. |

## 4. Network position

`ZT-005` — the API, database and backup storage carry **no public ingress**:

- Public entry is Front Door / WAF only; the API is reachable over a private
  endpoint.
- Service-to-service authentication uses **workload identity**, not shared
  secrets.
- `trustProxy: 1` — only the immediate hop's `X-Forwarded-For` is believed, so a
  client-supplied header cannot spoof the address used for rate limiting.

## 5. Application-layer settings worth checking after deployment

These are already implemented; this is the post-deploy verification list.

```bash
# CSP: nonce-based, no unsafe-inline, no unsafe-eval
curl -sI https://spendifre.example/healthz | grep -i content-security-policy

# HSTS with preload, nosniff, referrer policy, frame-ancestors none
curl -sI https://spendifre.example/healthz | grep -iE 'strict-transport|x-content-type|referrer|x-frame'

# No framework banner
curl -sI https://spendifre.example/healthz | grep -i x-powered-by   # expect nothing

# Unauthenticated API access
curl -s -o /dev/null -w '%{http_code}\n' https://spendifre.example/api/entities   # expect 401
```

Startup cross-checks that fail closed in production (each has a test):

| Setting | Production behaviour |
| --- | --- |
| `DEV_AUTH=on` | Refused — the local sign-in stub cannot be enabled by environment variable |
| `RATE_LIMIT=off` | Refused |
| `PUBLIC_ORIGIN` not `https://` | Refused |
| `DB_SSL_MODE=disable` | Refused |
| `SEED_MODE` other than `synthetic` | Refused — no fixture belongs in production |
| Entra ID configuration absent | Refused |
| `TELEMETRY_SALT` absent | Refused (no default anywhere) |

## 6. Identity hardening (Entra tenant, not the app)

The application re-checks these, so a policy gap fails closed rather than
silently granting access — but the policy still has to exist:

- **Conditional Access** requiring a compliant, managed device for
  `SG-Spendifre-Admin`, `-CFO` and `-Mgr-Finance` (`ZT-003`).
- **Phishing-resistant MFA.** Number matching is the stated minimum; **FIDO2 is
  what you actually want**, because phishing is the highest-likelihood initial
  access route in the threat model.
- **PIM** for the privileged roles: activation with justification, approval and
  expiry. No standing admin rights (`ZT-004`).
- **Quarterly access review** of all nine `SG-Spendifre-*` groups (`CMP-102`).
- **Sign-in risk policy** wired to session revocation. `revokeAllForUser()`
  exists; nothing calls it from an Entra risk event yet.

## 7. Backup hardening

- `BACKUP_ENCRYPTION_KEY` from Key Vault, rotated. The key is never stored
  beside the archive.
- `BACKUP_DIR` on a Blob container with CMK **and** an immutability policy.
- Restrict who holds `SG-Spendifre-Admin` — `backup.run` and `backup.download`
  are the two capabilities that move the whole dataset in one action.
- Alert on `backup.create` and `backup.download` audit events; they are
  deliberately low-frequency, so any unexpected one is worth a look.

## 8. What is deliberately *not* hardened

Stating this is more useful than a list of green ticks.

- **Restore.** Not implemented. An untested restore path invites false
  confidence; `CMP-107` needs a tested RTO/RPO before go-live.
- **Collusion.** Two actors — one submitting, one approving — defeat
  segregation of duties. The app makes it reconstructable, not impossible.
- **DDoS.** Application rate limiting is not a substitute for edge protection.
- **A compromised superuser.** They can disable the audit trigger. The hash
  chain makes that *detectable* (`audit_verify_chain()` pinpoints the row), not
  preventable.

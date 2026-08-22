# NIST CSF 2.0 and SP 800-207 mapping

`CMP-110` asks for a control mapping to NIST CSF 2.0 that stays current, and
`CMP-111` for an SP 800-207 Zero Trust implementation plus a maturity
assessment. `CMP-112` says to derive any SP 800-53 obligation from this profile
rather than maintaining a second inventory.

Status is deliberately blunt. **Implemented** means there is code and a test.
**Partial** means the code exists but something outside it is required.
**Open** means nothing is built.

---

## 1. CSF 2.0 profile

### GOVERN (GV)

| Subcategory | Status | Evidence |
|---|---|---|
| GV.OC — organisational context | Partial | `SPEC.md` §§1–5 define scope, actors and authority. ISO scope statement `CMP-101` still open. |
| GV.RM — risk management strategy | Partial | Residual risk register in `threat-model.md` §6; no formal risk appetite statement yet. |
| GV.RR — roles and responsibilities | Implemented | SPEC §5 permission matrix, encoded as data in `packages/shared/src/authz.ts` and enforced by 270 assertions. |
| GV.PO — policy | Partial | SDLC rules in SPEC §0 ("no ID, no code"; definition of done). Formal policy set is `CMP-104`. |
| GV.SC — supply chain risk | Partial | Lockfile, `npm audit` gate at `high`, SBOM target, deliberate dependency minimisation. Vendor assessment `CMP-105` open. |

### IDENTIFY (ID)

| Subcategory | Status | Evidence |
|---|---|---|
| ID.AM — asset management | Implemented (data assets) | Asset table in `threat-model.md` §1; field-level classification enforced in `data_classifications`. |
| ID.RA — risk assessment | Implemented (application) | STRIDE per trust boundary, ATT&CK mapping, honest "not mitigated" section. |
| ID.IM — improvement | Partial | Tests encode findings so regressions fail. No post-incident review process yet (`CMP-106`). |

### PROTECT (PR)

| Subcategory | Status | Evidence |
|---|---|---|
| PR.AA — identity, authentication, access control | Implemented | Entra OIDC + PKCE, no local accounts, deny-by-default matrix, entity scope re-derived per request, SoD in `CHECK` constraints, step-up before irreversible actions. |
| PR.AT — awareness and training | Open | Management-body training is `CMP-122`. |
| PR.DS — data security | Implemented | TLS 1.3 in transit; at rest via Azure platform encryption; session tokens stored only as SHA-256; IP/UA stored only as salted hashes; money as `numeric`, never float. |
| PR.PS — platform security | Partial | Strict CSP, full security-header set, least-privilege DB roles, no DDL for the app role. Hardened base image and patch cadence are platform work. |
| PR.IR — technology resilience | Partial | Statement timeouts, body caps, rate limits, bounded transactions. Backup/RTO/RPO is `CMP-107`. |

### DETECT (DE)

| Subcategory | Status | Evidence |
|---|---|---|
| DE.CM — continuous monitoring | Partial | Structured logs with credential redaction; every authorisation denial logged with its reason; CSP violation report endpoint. SIEM shipping is deployment work (`ZT-008`). |
| DE.AE — adverse event analysis | Partial | `audit_verify_chain()` is exposed as an endpoint so monitoring can alert on a broken chain. Alert rules for privilege change and mass export are specified, not yet configured. |

### RESPOND (RS) / RECOVER (RC)

| Subcategory | Status | Evidence |
|---|---|---|
| RS.MA / RS.AN | Partial | The audit trail is designed as incident evidence: append-only, hash-chained, actor and role denormalised so a later role change cannot rewrite history. |
| RS.MI | Implemented (session containment) | `revokeAllForUser` terminates every session for a principal on a risk signal. |
| RC.RP / RC.CO | Open | `CMP-107`. |

---

## 2. SP 800-207 Zero Trust — implementation and maturity

Assessed against the CISA Zero Trust Maturity Model levels
(Traditional → Initial → Advanced → Optimal).

| Tenet (SPEC `ZT-`) | Implementation | Maturity | Gap to next level |
|---|---|---|---|
| `ZT-001` Verify explicitly | Every request re-establishes identity, role and entity scope from the session row. No implicit trust from a prior request, VPN presence or network position. | **Advanced** | Continuous risk scoring per request |
| `ZT-002` Identity is the perimeter | Entra ID only. Roles from group claims. The app re-checks `amr` for privileged roles and fails closed if Conditional Access did not deliver strong auth. | **Advanced** | FIDO2 mandatory (currently number-matching minimum) |
| `ZT-003` Device signal | Device compliance carried on the session and re-checked per request for privileged roles. | **Initial → Advanced** | Compliance re-evaluation mid-session, not only at sign-in |
| `ZT-004` Least privilege, JIT | Deny-by-default matrix; write scope narrower than read scope; multiple group memberships resolve to the *least* privileged role. | **Advanced** | PIM activation with approval and expiry is a tenant configuration, not code |
| `ZT-005` Micro-segmentation | API, database and storage private-networked; workload identity rather than shared secrets. | **Initial** | Deployment-time; not demonstrable in this repository |
| `ZT-006` Assume breach | TLS 1.3; secrets only from Key Vault with no defaults; session tokens and telemetry identifiers stored only as hashes, so a database read yields nothing usable. | **Advanced** | Automated secret rotation evidence |
| `ZT-007` Continuous verification | Short session TTL, revocation on risk, and re-authentication required before approving, locking, purging or changing governance. | **Advanced** | Revocation driven by Entra risk events rather than manual |
| `ZT-008` Full telemetry | Auth events, every authorisation denial with its reason, data access and admin actions are logged structurally; export volume is audited with counts. | **Initial → Advanced** | SIEM integration and the three named alert rules |

**Overall: Advanced on identity and verification, Initial on network and
telemetry.** That split is expected for an application-layer implementation —
the remaining gaps are deployment and tenant configuration, and none of them are
blocked by the code.

---

## 3. Where SP 800-53 is contractually required

Derive from the profile above rather than maintaining a parallel inventory
(`CMP-112`). The high-traffic families and their evidence here:

| Family | Primary evidence |
|---|---|
| AC (Access Control) | `packages/shared/src/authz.ts`, `test/authz.test.ts` |
| AU (Audit and Accountability) | `db/migrations/002_audit.sql`, `FR-073` tests |
| IA (Identification and Authentication) | `packages/api/src/auth/` |
| SC (System and Communications Protection) | `packages/api/src/http/security.ts` |
| SI (System and Information Integrity) | `packages/shared/src/schemas.ts`, injection and XSS tests |
| CM (Configuration Management) | `packages/api/src/config.ts` production cross-checks; migration checksums |

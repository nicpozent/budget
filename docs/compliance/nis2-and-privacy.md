# NIS2, GDPR / revFADP and APAC — engineering position

Scope note: this is engineering scope, not legal advice. Every item marked
**Legal** needs a lawyer's answer before it can be closed. What this document
does is state precisely what the code already does, so the legal review starts
from facts rather than assumptions.

---

## 1. NIS2 (`CMP-120`–`CMP-124`)

### Applicability — unresolved, and the honest position

A retail group is **unlikely** to be an essential or important entity by sector
alone under Annex I/II. But two routes bring the obligations in anyway, and both
are live for Birgma:

1. **Contractual flow-down.** Customers and partners who *are* in scope push
   NIS2-equivalent obligations through their supply-chain clauses (Art. 21(2)(d)).
   This is the most common way a retailer inherits NIS2 in practice, and it does
   not require the group to be designated.
2. **Group composition.** If any group entity operates in a covered sector —
   logistics at scale, or managed digital infrastructure for third parties — the
   assessment changes.

**Do not assume out of scope.** `CMP-120` stays open until Legal answers.

### If in scope in Sweden (`CMP-121`)

| Obligation | Engineering readiness |
|---|---|
| Register with MSB / the competent authority | Not an engineering task |
| Cybersäkerhetslagen risk-management measures | Substantially met at application layer: risk analysis (`threat-model.md`), access control, cryptography, secure development, supply-chain scanning. Missing: BC/DR testing (`CMP-107`), incident process (`CMP-106`). |
| **24h early warning, 72h incident notification** | The audit trail is designed for this: append-only, hash-chained, actor and role denormalised so a later role change cannot rewrite history, and `audit_verify_chain()` shows whether the record is intact. What is missing is the *process* — who declares, who notifies, and the timer. |
| Management-body accountability and training (`CMP-122`) | Open. Not code. |
| Supply-chain obligations flowed to our own vendors (`CMP-124`) | Open. Our own dependency posture is covered by `SEC-040`. |

Switzerland is outside NIS2 (`CMP-123`); the Swiss NCSC reporting duty is a
separate assessment with its own trigger and timeline.

---

## 2. GDPR (Sweden) and revFADP (Switzerland)

`CMP-136` is worth restating because it is routinely got wrong: **revFADP is a
separate regime, not a Swiss copy of GDPR.** Compliance with GDPR alone leaves
gaps — a Swiss register, a Swiss privacy notice, a Swiss transfer list, and
possibly a Swiss representative.

### Record of processing (`CMP-130`) — personal data actually held

Derived from the schema, not from a guess. These are the fields classified
`personal_data` in `data_classifications`:

| Data | Where | Purpose | Retention |
|---|---|---|---|
| Name, email, Entra `oid` | `users` | Identify the budget owner / approver | 24 months after inactivity |
| Role | `users` | Authorisation | With the account |
| Comment and justification authorship | `line_comments`, `audit_events` | Collaboration; financial-control evidence | 36 months (free text) / 84 months (audit) |
| Audit actor and role | `audit_events` | Accountability, ICFR (`CMP-150`) | 84 months |
| Session IP and user-agent | `sessions` | Detect session relocation | **Salted SHA-256 only** — enough to notice a change, not enough to rebuild a browsing history |
| Headcount driver values | `drivers` | Driver-linked budgeting | With the cycle |
| Names inside free text | `line_comments`, `justification` | Incidental | Purged by the retention job |

Two deliberate minimisation choices (`CMP-132`): IP and user-agent are **never**
stored in the clear, and the data-subject export deliberately returns the
person's own records rather than the budget figures they touched — those are
commercial data belonging to the group, not personal data belonging to them.

### Data subject rights (`CMP-133`) — implemented as features, not scripts

`PRIV-003` requires these to be first-class. They are:

| Right | Endpoint | Behaviour |
|---|---|---|
| Access / portability | `GET /api/governance/subject/:userId/export` | Returns the person's user record, their comments, and their audit entries as JSON. The export is itself audited. |
| Erasure | `POST /api/governance/subject/:userId/pseudonymise` | **This is the interesting one.** Erasure must not break the audit chain. The user row is pseudonymised (email replaced with an invalid-domain placeholder, name replaced, `entra_oid` cleared, account deactivated) and their free text is deleted — but the audit events survive. They still exist, still hash-link, and still prove who approved what, while no longer identifying a person. Deleting them instead would break both the chain and the statutory accounting record. |
| Restriction | Deactivation | `is_active = false` ends access at the next request; sessions are revoked immediately. |
| Rectification | Standard admin edit | Audited. |

Both endpoints require `governance.edit` (Admin or CFO only) and are step-up
capabilities — re-authentication is required (`ZT-007`).

### Storage limitation (`PRIV-001`)

Retention is enforced by a job, not by a policy document — the spec is explicit
that "retention that is documented but not executed is a finding". Defaults from
SPEC §9.2 are seeded: audit 84 months, budget records 120, free text 36,
inactive users 24. `POST /api/governance/retention/run` executes it and writes
an audit event with the counts purged.

Audit purging is the one place where `FR-073` ("never deletable, by anyone") and
`PRIV-001` ("enforce 84 months") genuinely conflict. The resolution:

- The application role holds **no** `DELETE` on `audit_events`.
- The trigger refuses `DELETE` unless a session GUC is set *and* the row is past
  its configured retention — so even a leaked GUC cannot purge recent history.
- Only `audit_purge_expired()`, a `SECURITY DEFINER` function granted solely to
  the retention role, can set that GUC.
- After purging it **re-anchors the hash chain** to the surviving head, so the
  record remains verifiable from a recorded value rather than silently failing
  verification forever.

### Still open (Legal)

- `CMP-131` lawful basis and an employee-facing notice covering the monitoring
  the audit trail implies. The audit trail records individual actions; that is
  employee monitoring and needs to be disclosed.
- `CMP-134` DPIA. Cross-border scope, employee monitoring and
  profiling-adjacent headcount planning make this near-certain to be required.
- `CMP-135` processor agreements and transfer mechanism (SCCs + TIA).
- `CMP-137` breach notification: 72h to the IMY; FDPIC on its own terms.

---

## 3. APAC and the PIPL blocker (`CMP-140`–`CMP-145`)

`CMP-140` is the architectural blocker: a single global tenant is likely not
lawful for mainland China, and the workbook spans CNY, HKD, TWD, VND, IDR, THB,
MYR, PHP, INR, BDT, LKR, KRW and LAK.

**What the code does today, pending that decision:**

Every entity carries a `residency` of `eu`, `ch`, `apac` or `cn`. The
deployment's own region is configuration. The single scope resolver that every
read path calls applies the region filter alongside the caller's read scope, and
single-entity endpoints apply it too. The result is that an EU deployment
returns 404 for a mainland-China entity **even to an administrator whose
capability would otherwise permit it**, and a misrouted connection string or a
mistakenly attached replica fails closed rather than exporting data across a
border. There is a test for exactly this.

This does not make the group PIPL-compliant. It makes the code ready for
whichever topology Legal chooses, and it removes the failure mode where a
deployment quietly serves data it should not.

Remaining APAC items (`CMP-141`–`CMP-145`: Singapore PDPA, Japan APPI, India
DPDPA, Australia APPs, and the HK/KR/TW/ID/TH/VN/PH/LK/BD set) need the same
triage: confirm which entities process personal data, then map obligations. The
`residency` column is the hook to extend when the answer arrives.

---

## 4. Financial control (`CMP-150`–`CMP-152`)

| Requirement | Position |
|---|---|
| Segregation of duties | Enforced in data: `CHECK` constraints mean the submitter can never be the approver and the cost-centre creator can never be its approver, regardless of what the application layer does. Three tests, two at the database level. |
| Change management | Migration checksums refuse a file that changed after being applied; requirement ID in every commit message. |
| Complete audit trail | `FR-070`/`FR-073`, hash-chained. |
| Approval evidence reproducible for the statutory period | 120-month retention on budget records; per-line decisions retained with actor, timestamp and free-text reason. |
| SOX or equivalent (`CMP-152`) | Not currently applicable; control testing would attach to the same evidence. |

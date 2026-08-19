# Record of processing activities (`CMP-130`)

GDPR Article 30(1). This is the engineering contribution to the controller's
record: every category of personal data the system actually holds, derived from
the schema and the `data_classifications` table rather than from intent.

> **Status: drafted, not adopted.** A RoPA is a controller's document. What is
> here is accurate about the system; the controller identity, the DPO contact,
> the retention decisions the business has actually agreed, and the transfer
> mechanism in force are the organisation's to confirm. Fields needing that
> confirmation are marked **[org]**.

_Last verified against migration `005_versioning_stages_ledger.sql`._

## 1. Controller and roles

| Article 30(1) item | Value |
| --- | --- |
| Controller | **[org]** Birgma International AB (to confirm; group structure may make this joint controllership with the Biltema entities) |
| Representative | **[org]** not applicable if the controller is EU-established |
| Data Protection Officer | **[org]** contact to be recorded |
| Joint controllers | **[org]** to determine — 21 entities across four residency regions |
| Processors | Microsoft (Entra ID, identity); **[org]** hosting provider once chosen |

Spendifre is an internal system. There is no processing on behalf of a third
party, so no Article 30(2) record is required of it.

## 2. Processing activities

### 2.1 Budget preparation and approval

| Item | Value |
| --- | --- |
| Purpose | Preparing, reviewing and approving the group IT budget |
| Categories of data subject | Employees of the group who hold a Spendifre role: budget owners, approvers, administrators |
| Categories of personal data | Name, work email, Entra object identifier, role, entity ownership, authorship of every figure and comment |
| Recipients | Group IT Finance, the CFO, the entity's own budget owner. No external recipient |
| Retention | Budget data 120 months; free text 36 months (`retention_policies`) |
| Security measures | §4 below |

Note that the *budget figures themselves* are commercial rather than personal
data — but they are attributed. "Who set this figure" is personal data about the
person who set it, which is why authorship, not just amount, appears above.

### 2.2 Audit trail

| Item | Value |
| --- | --- |
| Purpose | Financial control, non-repudiation, and security incident investigation |
| Categories of data subject | Every authenticated user |
| Categories of personal data | Actor user id, role at the time, action, target, free-text detail, timestamp, salted hash of IP address and user agent |
| Recipients | Administrators and the CFO (`audit.viewAll`); each user sees their own events (`audit.viewOwn`) |
| Retention | 84 months, enforced by `audit_purge_expired()` |
| Security measures | Append-only by grant, trigger and SHA-256 hash chain; purge re-anchors the chain |

The audit trail is the processing that makes a DPIA necessary
([`dpia-personnel-data.md`](./dpia-personnel-data.md)). IP address and user agent
are stored as salted hashes and never in the clear, so they support "was this the
same session" without being an address book.

### 2.3 Authentication and session management

| Item | Value |
| --- | --- |
| Purpose | Authenticating users and enforcing access control |
| Categories of data subject | Every user who signs in |
| Categories of personal data | Entra object identifier, email, display name, authentication method (`amr`), device-compliance signal, session timestamps, salted IP/UA hashes |
| Recipients | None. Session rows are excluded from backups by an explicit table allow-list |
| Retention | Sessions expire and are deleted; inactive user accounts pseudonymised after 24 months |
| Source | Microsoft Entra ID (Article 14 applies — the data does not come from the subject directly) |

### 2.4 Personnel cost lines

| Item | Value |
| --- | --- |
| Purpose | Planning staff-related IT cost |
| Categories of data subject | Employees named in a line, most often in training and consultancy lines |
| Categories of personal data | Whatever an owner types into a line name, justification or comment — free text is uncontrolled |
| Recipients | The entity's owner, cross-entity readers, the CFO |
| Retention | Free text 36 months |
| Risk | This is the highest-uncertainty category in the record, because the content depends on what people type. See §5 |

### 2.5 Ledger ingestion (FR-040)

| Item | Value |
| --- | --- |
| Purpose | Replacing hand-recorded actuals with booked figures |
| Categories of personal data | The identity of the account that posted the batch; the ledger's own posting references, which may embed a requisitioner |
| Recipients | Administrators |
| Retention | Follows budget data, 120 months |
| Source | **[org]** the finance system, once chosen |

## 3. Transfers to third countries

> **This section was written for a per-region topology and the topology has
> changed.** The group has chosen a single central deployment, which removes the
> arrangement in which no personal data crossed a border and inverts the
> direction of every row below. It needs redoing by Legal before go-live, and
> the table is left in place only so the delta is visible.
>
> Two things change, and neither is paperwork:
>
> **The direction.** These rows describe transfers *out of* the EU. A central EU
> deployment receiving APAC and Swiss data is an *import*, governed by each
> source jurisdiction's export rules rather than by EU standard contractual
> clauses alone.
>
> **The granularity.** `apac` is one bucket in the schema and several regimes in
> law. The entities in it today are Singapore, India, Vietnam and one entity
> whose country the model does not record — so `CMP-141` (Singapore PDPA),
> `CMP-143` (India DPDPA) and `CMP-145` (Vietnam PDPD) all apply and none of
> them is "APAC".

| Region | Entities | Basis |
| --- | --- | --- |
| EU (`eu`) | Majority | No transfer |
| Switzerland (`ch`) | Swiss entities | **[org]** Adequacy covers EU→CH; CH→EU is governed by the Swiss FADP and needs its own analysis under a central deployment |
| APAC (`apac`) | Singapore, India, Vietnam, and one entity of unrecorded country | **[org] Per jurisdiction, not per bucket** — `CMP-141`, `CMP-143`, `CMP-145`. The single `apac` value cannot express which regime applies to which entity |
| Mainland China (`cn`) | Chinese entities | **[org] Unresolved — `CMP-140`.** PIPL requires a separate lawful basis and probably local storage. Central hosting makes this the go-live blocker rather than an architectural one |

The application enforces residency in one place — the entity scope resolver —
and `SERVED_REGIONS` names the regions a deployment serves, defaulting to its
own alone. That is a technical control supporting whatever decision Legal makes;
it is not itself a transfer mechanism.

**Its granularity is the buckets, though.** `SERVED_REGIONS` is all-or-nothing
per bucket, and `entities` records a region but no country, so a deployment
cannot serve Singapore while Legal is still working through India. If the answer
turns out to differ by jurisdiction — which the list above suggests it will —
the model needs a country on the entity before the control can express it. That
is a small change and it is deliberately not made yet: guessing which country
each entity sits in would be inventing a compliance fact.

## 4. Security measures (Article 30(1)(g))

Summarised here; the detail is in
[`security-hardening.md`](./security-hardening.md).

- Access control from Entra group membership, re-derived per request, deny by
  default at route registration.
- Object-level authorisation on every entity-addressed route; out-of-scope reads
  return 404 rather than 403.
- Encryption in transit to the browser and to the database; backups encrypted
  with AES-256-GCM and bound to their region.
- Least-privilege database roles; the application holds no DDL and cannot delete
  audit rows.
- Append-only audit with tamper detection.
- Automated retention enforcement with an audited count per run.
- Pseudonymisation on erasure that preserves the audit chain.

## 5. Known gaps in this record

Stated rather than left for an audit to find.

1. **Free text is unbounded.** §2.4 says "whatever an owner types". A RoPA
   category that cannot be enumerated is a weak category, and the honest
   mitigation is organisational — tell owners not to name individuals — plus the
   36-month retention that already applies.
2. **The real workbook is in the repository** and contains named individuals
   ([`osint-exposure.md`](./osint-exposure.md) §1). It is not processed by the
   application, but it exists, and a RoPA that omitted it would be incomplete.
3. **Processor list is incomplete** until hosting is chosen.
4. **Joint controllership** across 21 entities in four regions is unresolved and
   affects who answers a data subject request.

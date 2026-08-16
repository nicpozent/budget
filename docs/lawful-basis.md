# Lawful basis and legitimate interests assessment (`CMP-131`)

Closes open actions 2 and 3 in
[`dpia-personnel-data.md`](./dpia-personnel-data.md) §5.

> **Status: drafted, not decided.** Choosing a lawful basis is the controller's
> decision and it is not reversible in practice — you cannot switch basis later
> because the first one became inconvenient. This document sets out the analysis
> and the recommendation; Legal and the DPO decide.

## 1. Basis per processing activity

| Processing | Recommended basis | Reasoning |
| --- | --- | --- |
| Budget preparation and approval | Art. 6(1)(b)-adjacent **legitimate interests**, Art. 6(1)(f) | The employment contract is with the employer, not the data subject in their capacity as a system user, so 6(1)(b) is a poor fit even though the work is contractual. 6(1)(f) is the honest answer |
| Audit trail | **Legitimate interests**, Art. 6(1)(f), *and* **legal obligation**, Art. 6(1)(c), for the part supporting statutory bookkeeping | See §2 and §3 |
| Authentication and access control | **Legitimate interests**, Art. 6(1)(f) | Securing a system holding commercial data. Uncontroversial |
| Personnel cost lines | **Legitimate interests**, Art. 6(1)(f) | With the caveat in §4 |
| Ledger ingestion | **Legal obligation**, Art. 6(1)(c) | Bookkeeping records under bokföringslagen |

**Consent is not available.** An employee cannot freely refuse to be recorded by
the system they must use to do their job. Consent obtained under that imbalance
is not freely given (Art. 4(11), and the EDPB's consistent position on
employment). Recording consent here would be worse than not relying on it,
because it would imply a right to withdraw that does not exist.

**Special categories.** None are processed. Free text could in principle contain
Article 9 data if someone wrote it — for example a health-related reason in a
justification. Nothing in the system invites it, retention is 36 months, and the
privacy notice asks people not to name individuals. This is a residual risk, not
a designed processing.

## 2. Legitimate interests assessment — the audit trail

The three-part test.

### Purpose test: is the interest legitimate?

Yes, and there are three distinct interests:

1. **Financial control.** The budget determines real spend across 21 entities.
   Knowing who proposed and who approved a figure is the basis of segregation of
   duties, which is itself a control the organisation is expected to have.
2. **Non-repudiation.** An approval that cannot be attributed is not an approval.
3. **Security incident investigation.** If an account is compromised, the record
   is how the blast radius is established.

None of these is speculative — they are the reasons the feature exists, and each
maps to a numbered requirement (`FR-070`–`FR-073`, `SEC-012`, `ZT-008`).

### Necessity test: is the processing necessary?

Could the purposes be met with less?

| Alternative | Why it does not work |
| --- | --- |
| Record the change without the actor | Defeats all three purposes. An unattributed change record is a diff, not a control |
| Record only approvals, not edits | A figure can be moved before approval; the trail would have a gap exactly where a dispute would fall |
| Retain for less than 7 years | The audit trail supports statutory bookkeeping, whose Swedish retention is 7 years. Shorter would break the obligation |
| Pseudonymise the actor immediately | Removes the ability to investigate, which is the point |

What *was* reduced: IP address and user agent are stored as salted hashes rather
than in the clear. That keeps "same session or not" and discards "where this
person was". This is the necessity test doing real work rather than being
recited.

### Balancing test: do the interests override the individual's?

| Factor | Assessment |
| --- | --- |
| Reasonable expectations | An employee entering figures into a corporate finance system reasonably expects those entries to be attributed. This is not covert monitoring |
| Nature of the data | Professional activity in a work system. Not special category, not private life |
| Intrusiveness | Low per event; the *aggregate* is what warrants care — a 7-year record of one person's working patterns is more revealing than any single row |
| Power imbalance | Real. The employee cannot opt out. This is what makes the purpose-limitation commitment in §3 load-bearing rather than decorative |
| Safeguards | Access limited to `audit.viewAll` holders (Administrator, CFO); each person can read their own record; automated retention; tamper-evident storage so the record cannot be altered against them either |
| Individual's control | Right to object available; erasure honoured by pseudonymisation |

**Conclusion: the balance favours processing**, conditional on the purpose
limitation in §3 being adopted in writing. Without it, the aggregate record is a
performance-monitoring capability that nobody has agreed to, and the balance
would be much closer.

## 3. Purpose limitation commitment

Proposed wording for the organisation to adopt. This is open action 3 in the
DPIA, and §2 depends on it.

> The Spendifre audit trail is processed for financial control, non-repudiation
> and security incident investigation. It will not be used to assess individual
> performance, productivity or working patterns, and it will not be provided for
> that purpose to line management or HR. Access for any purpose other than those
> stated requires the approval of the Data Protection Officer, and the request
> and its outcome will themselves be recorded.

Two notes on making this real rather than stated:

- **`audit.viewAll` is held by Administrator and CFO only.** The commitment is
  enforceable because the population that could breach it is small and named.
- **The system cannot enforce intent.** Nothing technical stops a CFO reading the
  trail for the wrong reason. The control is the commitment plus the fact that
  reads are themselves audited — which is a deterrent, not a prevention, and
  should be described as such.

## 4. The personnel-cost-lines caveat

Lines naming individuals — most often training and consultancy — are the weakest
part of this assessment, for a reason worth stating plainly: the data subject
there is usually **not the system user**. They are a colleague who never sees
Spendifre, has not been given the privacy notice, and may not know a line exists
with their name on it.

That makes it **Article 14** processing (data not obtained from the subject),
which carries its own information obligation. Three options, for the
organisation to choose between:

1. **Stop naming individuals.** Change the practice so lines describe a role or
   an activity. Cleanest, and the privacy notice already asks for it.
2. **Extend the notice.** Cover it in the general employee privacy information,
   relying on Art. 14(5)(b) disproportionate-effort where individual notice is
   impractical.
3. **Accept and document.** Least defensible, and only viable if (1) is genuinely
   impossible.

The engineering position is that (1) costs nothing and removes the problem.

## 5. Review

A legitimate-interests assessment is not a one-time artefact. It should be
revisited when:

- the retention periods change,
- `audit.viewAll` is granted to a new role,
- the audit trail is exported anywhere new,
- ledger integration begins (it changes who appears in the record), or
- the `CMP-140` residency decision lands, since PIPL does not recognise
  legitimate interests as a basis at all — Chinese entities will need separate
  consent or a statutory basis.

That last point is the one most likely to be missed: **this entire assessment is
GDPR reasoning and does not transfer to mainland China.**

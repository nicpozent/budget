# DPIA — personnel data in Spendifre

Data Protection Impact Assessment under GDPR Art. 35 (`CMP-134`). This is the
**engineering input** to a DPIA, not a completed one: §5 and §6 are for the
organisation to finish, and nothing here is legal advice.

---

## 1. Why a DPIA is needed

Art. 35(3) triggers plus the WP29 criteria that apply here:

- **Systematic monitoring of employees.** The audit trail records every
  state-changing action with the actor's identity, role and timestamp, and
  retains it for 84 months.
- **Evaluation or scoring, adjacent.** Headcount planning links budget to people
  counts per entity. Aggregate today; if granularity ever drops to team or
  individual, it becomes profiling-adjacent.
- **Data processed at scale across borders.** 21 entities spanning the EU,
  Switzerland and APAC, with mainland China unresolved (`CMP-140`).
- **Vulnerable data subjects in the relevant sense** — employees cannot freely
  refuse, which is why consent is the wrong lawful basis.

## 2. Description of the processing

| | |
| --- | --- |
| **Purpose** | Govern the group IT budget cycle: plan, approve, and retain reproducible approval evidence for financial control (`CMP-150`) |
| **Categories of data subject** | Budget owners, approvers, administrators, comment authors — all employees |
| **Categories of personal data** | Name, work email, Entra object id, role, comment and justification authorship, audit actor identity, session activity timestamps, salted IP/user-agent hashes |
| **Special categories** | **None.** No health, biometric, union membership or similar data |
| **Recipients** | Group IT Finance, CFO, and each manager for their own scope |
| **Transfers** | Within the group; Microsoft as processor. Non-EEA transfers need SCCs + TIA (`CMP-135`) |
| **Retention** | Audit 84 months · free text 36 · inactive users 24 · budget records 120 |
| **Lawful basis** | **[Legal]** — legitimate interest with a documented balancing test is the likely answer for financial control. Not consent: employment is not a free choice |

## 3. Necessity & proportionality

**Necessary?** Yes for the audit trail: `CMP-150` and `CMP-151` require
approval evidence attributable to a person and reproducible for the statutory
period. An anonymous audit trail would not satisfy internal control over
financial reporting.

**Proportionate?** The design argues yes, and the arguments are built rather
than asserted:

| Minimisation applied | Where |
| --- | --- |
| Managers see **only their own** audit entries, filtered in the query, never merely hidden | `FR-071` |
| IP and user-agent stored **only** as salted SHA-256 | `sessions` table |
| Session tokens stored only as hashes — a database read yields no usable session | `auth/session.ts` |
| Data subject export returns the person's **own** records, not the budget figures they touched | `governance/subject/:id/export` |
| Free text purged at 36 months, well before the audit period | Retention job |
| No behavioural analytics, no keystroke or screen capture, no location data | By design |

**Less intrusive alternative?** A role-level rather than person-level audit
trail. Rejected: it would defeat `SEC-012` (segregation of duties) and
`CMP-151` (reproducible approval evidence), which are the reasons the system
exists.

## 4. Risks to data subjects & mitigations (as built)

| Risk | Likelihood | Severity | Mitigation | Residual |
| --- | --- | --- | --- | --- |
| Employee feels surveilled; chilling effect on legitimate budget discussion | Medium | Medium | `FR-071` scoping; audit view states plainly what is recorded and who can see it | **Medium — requires the privacy notice (`CMP-131`)** |
| Audit trail used for performance management beyond its purpose | Medium | High | Purpose limitation is policy, not code. The system cannot prevent misuse by an authorised viewer | **Medium — needs a written purpose-limitation commitment** |
| Free text captures more personal data than intended | Medium | Low | Length bounds; 36-month purge; `CMP-132` challenges every free-text field | Low |
| Erasure request breaks the statutory record | Low | High | Pseudonymisation retains the chain and the evidence while removing identity | **Low — implemented and tested** |
| Cross-border transfer without a mechanism | Medium | High | Residency enforced in code; an EU deployment refuses other regions' rows | **High until `CMP-140` and `CMP-135` are resolved** |
| Development fixture re-identified | Low | Medium | Anonymiser; but it reports **16 of 21 entities remain structurally unique** | **Medium — the fixture is pseudonymous, not anonymous** |
| Real workbook present in the repository | **Confirmed** | High | Application cannot read it; CI gate. The file itself is still there | **High — see `osint-exposure.md` §1** |

## 5. Residual risk & open actions **[org to complete before go-live]**

1. **Privacy notice** to employees covering the audit trail — the single
   outstanding transparency obligation.
2. **Lawful basis** recorded, with a legitimate-interest balancing test.
3. **Purpose limitation** committed in writing: the audit trail is for financial
   control and incident investigation, not performance management.
4. **MBL §11** position confirmed (see [`compliance-sweden.md`](./compliance-sweden.md)).
5. **`CMP-140` PIPL decision** — the highest residual risk in the table.
6. **Decide the fate of `design/budget-data.js`**, which contains named
   individuals in the training lines.
7. **Consult the DPO**, and consider whether Art. 36 prior consultation with IMY
   is needed given cross-border scope.

## 6. Sign-off

| Role | Name | Date | Outcome |
| --- | --- | --- | --- |
| Data Protection Officer | [ ] | [ ] | [ ] |
| Business owner (Group IT Finance) | [ ] | [ ] | [ ] |
| Security | [ ] | [ ] | [ ] |
| Works council / union consulted | [ ] | [ ] | [ ] |

> Not signed off. This document is the engineering contribution; the assessment
> is not complete until §5 is closed and §6 is signed.

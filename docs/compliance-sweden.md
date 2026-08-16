# Sweden-specific compliance

Swedish obligations that sit **on top of** the pan-EU picture in
[`compliance-nis2-and-privacy.md`](./compliance-nis2-and-privacy.md). Engineering
scope, not legal advice — every item marked **[Legal]** needs a lawyer's answer.

Birgma / Biltema is a Nordic retail group with entities in Sweden, Switzerland
and APAC. Spendifre's primary deployment is Azure Sweden Central.

---

## 1. Employment & co-determination

Most relevant because the audit trail records individual employee actions.

- **MBL (Medbestämmandelagen, 1976:580) §11** — an employer must negotiate with
  the union before a significant change to operations or working conditions.
  Introducing a system that records and attributes every action a budget owner
  takes is plausibly in scope. **[Legal]** Confirm whether MBL negotiation is
  required before go-live, and whether the works council must be consulted.
- **Arbetsmiljölagen** — monitoring that affects the psychosocial work
  environment. The audit trail is proportionate to a financial-control purpose,
  but that argument should be made explicitly rather than assumed.
- **Practical mitigation already built:** `FR-071` — managers see only their own
  audit entries, enforced in the query. Only Admin and CFO see everything. That
  materially narrows the monitoring surface, and it is worth putting in front of
  the union as a design choice rather than an accident.

## 2. Data protection (the Swedish layer on GDPR)

- **Dataskyddslagen (2018:218)** — the Swedish supplementing act.
- **IMY** (Integritetsskyddsmyndigheten) is the supervisory authority. **72-hour
  breach notification** (`CMP-137`).
- **Employee monitoring.** IMY's guidance on workplace monitoring expects
  necessity, proportionality and transparency. Spendifre's audit trail is
  necessary for `CMP-150`, and the scoping in `FR-071` is the proportionality
  argument — but the **transparency leg is missing**: there is no
  employee-facing privacy notice yet (`CMP-131`). This is the most concrete
  Swedish gap.
- **[Legal]** Confirm the lawful basis. Legitimate interest is the likely
  answer for financial control, with a documented balancing test; consent is
  the wrong basis in an employment relationship.

## 3. Financial & accounting

- **Bokföringslagen (1999:1078)** — accounting records must be retained for
  **seven years**. Spendifre's `budget` retention is 120 months (ten years) and
  `audit` is 84 months (seven), so both clear it. Note that budget *plans* are
  not themselves accounting records; approval evidence tied to booked spend may
  be. **[Legal/Finance]** Confirm which Spendifre records are räkenskapsinformation.
- **Retention format.** Bokföringslagen requires records be readable for the
  full period. A backup encrypted with a key that has been rotated away is not
  readable — see the rotation hazard in [`secrets.md`](./secrets.md) §4.
- **Archiving location.** Historically Swedish law constrained where accounting
  records could be stored; the rules were relaxed, but **[Legal]** confirm for
  cloud storage in Sweden Central.

## 4. Accessibility procurement

- **Lagen om tillgänglighet till digitala offentliga tjänster (2018:1937)**
  applies to public bodies. Biltema is private, so this is **not** directly
  applicable — but EN 301 549 conformance is routinely requested in Swedish
  procurement and by public-sector customers.
- The **European Accessibility Act** (Swedish implementation from June 2025)
  reaches private-sector services in defined categories. An internal budgeting
  tool is unlikely to be in scope. **[Legal]** confirm; the cost of being wrong
  is low because WCAG 2.2 AA is already met and CI-gated.

## 5. Applicability to verify (do not assume "covered")

| Item | Question | Owner |
| --- | --- | --- |
| MBL §11 | Does introducing an attributed audit trail require union negotiation? | HR + Legal |
| Lawful basis | Legitimate interest with a balancing test, documented? | Legal |
| Privacy notice | Employee-facing notice covering the audit trail | Legal + HR |
| Bokföringslagen | Which Spendifre records are accounting records? | Finance |
| NIS2 | Sector assessment plus supply-chain flow-down (`CMP-120`) | Legal |
| revFADP | Switzerland is a **separate regime**, not a GDPR copy (`CMP-136`) | Legal |

## Implemented lifecycle controls

What already exists, so the legal review starts from facts:

- Retention periods enforced by a job that audits its own counts (`PRIV-001`).
- Data subject access and erasure as first-class endpoints, with erasure
  pseudonymising the actor and **keeping the audit chain intact** (`CMP-133`).
- Audit scoping so a manager sees only their own actions (`FR-071`).
- IP and user-agent stored only as salted hashes (`CMP-132`).
- Field-level classification, editable only by Admin and CFO and audited.
- Residency enforced in code — an EU deployment refuses to serve Swiss, APAC or
  mainland-China rows.

## Tracked to-dos before production

1. **Employee-facing privacy notice** covering the audit trail (`CMP-131`).
2. **DPIA** — see [`dpia-personnel-data.md`](./dpia-personnel-data.md) (`CMP-134`).
3. **RoPA entry** for Spendifre (`CMP-130`).
4. **MBL position** confirmed in writing.
5. **Processor agreements** with Microsoft and sub-processors; SCCs plus a
   transfer impact assessment for non-EEA processing (`CMP-135`).
6. **IMY breach process** with a named owner and the 72-hour clock defined.

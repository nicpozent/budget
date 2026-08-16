# Spendifre — Functional Flows

Three views of the system: how **data** moves and where each control sits,
how **users** get work done per role, and how the **engineering** pieces
interact at build, test, run and deploy.

Source diagrams are in [`flows/`](./flows) as Mermaid `.mmd`; rendered SVGs
are in [`images/`](./images) and collected in
[`flows-gallery.html`](./flows-gallery.html).

| Group | Diagrams |
|---|---|
| System & data flows | 18 |
| User journeys | 4 |
| Software-development interaction | 6 |

---

# System & data flows

How Spendifre moves data and where each control sits in the path.

## Application map & navigation

<sub>`flows/00-app-sitemap.mmd`</sub>

```mermaid
graph LR
  APP(["Spendifre"]):::start
  APP --> PLAN["Plan"]
  APP --> ANALYSE["Analyse"]
  APP --> APPROVE["Approve"]
  APP --> GOVERN["Govern"]
  PLAN --> P1["Budget entry<br/>grid, line drawer, bulk ops"]
  PLAN --> P2["Actuals<br/>consumption vs pace"]
  ANALYSE --> A1["Variance<br/>this year vs prior"]
  ANALYSE --> A2["Consolidation<br/>group total, category split"]
  APPROVE --> R1["Submissions<br/>submit / decide / per-line"]
  APPROVE --> R2["Cost centres<br/>registry and approval"]
  GOVERN --> G1["Audit trail"]
  GOVERN --> G2["Data governance<br/>classification, retention, DSR"]
  GOVERN --> G3["Operations<br/>backup, export"]
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Authentication — Entra ID, OIDC + PKCE

<sub>`flows/01-auth-rbac.mmd`</sub>

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant API as Spendifre API
  participant DB as PostgreSQL
  participant E as Microsoft Entra ID

  B->>API: GET /auth/login?next=/
  API->>DB: store state + nonce + PKCE verifier
  API-->>B: 302 to Entra (code challenge S256)
  B->>E: authenticate (Conditional Access, MFA, device)
  E-->>B: 302 /auth/callback?code&state
  B->>API: GET /auth/callback
  API->>DB: consume state (single use)
  API->>E: exchange code + PKCE verifier
  E-->>API: id_token (groups, amr, oid, deviceid)
  API->>API: groups to role, least privilege wins
  API->>DB: link or provision user, create session
  API-->>B: Set-Cookie sid (HttpOnly) + csrf
  Note over API,DB: every later request re-derives<br/>role and entity scope from the session row
```

## Request lifecycle & authorisation gate

<sub>`flows/02-request-authorisation.mmd`</sub>

```mermaid
graph TB
  REQ(["Incoming request"]):::start --> HDR["Security headers<br/>CSP nonce, HSTS, no-store"]:::ctrl
  HDR --> DECL{"Route has a security<br/>declaration?"}:::ctrl
  DECL -->|no| BOOT["Refused at registration<br/>server does not start"]:::ctrl
  DECL -->|yes| RL["Rate limit<br/>per user, else per IP"]:::ctrl
  RL --> SESS{"Valid session?"}
  SESS -->|no| PUB{"Route public?"}
  PUB -->|no| E401["401 unauthenticated"]:::ctrl
  PUB -->|yes| H
  SESS -->|yes| PRIV{"Privileged role?"}
  PRIV -->|yes| DEV{"Compliant device<br/>and strong amr?"}:::ctrl
  DEV -->|no| E401
  DEV -->|yes| CSRF
  PRIV -->|no| CSRF{"State-changing?"}
  CSRF -->|yes| TOK{"CSRF token and<br/>same origin?"}:::ctrl
  TOK -->|no| E403["403 forbidden"]:::ctrl
  TOK -->|yes| CAP
  CSRF -->|no| CAP{"Role holds the<br/>capability?"}
  CAP -->|no| E403
  CAP -->|yes| STEP{"Step-up capability?"}
  STEP -->|yes, auth stale| E401S["401 step_up_required"]:::ctrl
  STEP -->|no| H["Handler"]
  H --> SCOPE{"Entity in scope<br/>and in region?"}
  SCOPE -->|read, no| E404["404 not found"]:::ctrl
  SCOPE -->|write, no| E403
  SCOPE -->|yes| TX["Transaction:<br/>mutate + audit together"]:::data
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Budget entry — grid edit round trip

<sub>`flows/03-budget-entry.mmd`</sub>

```mermaid
sequenceDiagram
  autonumber
  actor O as Budget owner
  participant UI as Grid
  participant API as API
  participant DB as PostgreSQL

  O->>UI: choose entity
  UI->>API: GET /api/budget/:entityId
  API->>DB: one query, lines + periods + actuals
  API->>API: FX at read time, fold to totals
  API-->>UI: lines, category totals, entity total
  O->>UI: type a quarter amount
  UI->>API: PUT /api/lines/:id/amounts {period, amount, unit, version}
  API->>API: reject if driver-linked (INV-3)
  API->>API: if unit=eur convert to local (FR-014)
  API->>DB: version check, upsert amount, audit event
  alt version stale
    API-->>UI: 409 conflict, reload and retry
  else applied
    API-->>UI: 200, grid refetches
  end
```

## Line detail, drivers and dormancy

<sub>`flows/04-line-detail-drivers.mmd`</sub>

```mermaid
graph LR
  L(["Line"]):::start --> D{"Driver linked?"}
  D -->|no| M["Manual amounts<br/>editable per period"]:::data
  D -->|yes| C["Amount = driverValue x rate"]:::data
  C --> RO["Quarter inputs read-only<br/>expression shown in grid"]:::ctrl
  C --> HC{"Driver = headcount?"}
  HC -->|yes| TOG{"Headcount planning<br/>enabled for the cycle?"}
  TOG -->|no| DORM["Dormant: reverts to the stored<br/>manual value, nothing deleted"]:::ctrl
  TOG -->|yes| C
  L --> CC{"Cost centre approved?"}
  CC -->|no| EXC["Rendered as an exception<br/>never silently cleared (INV-2)"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Bulk operations over a selection

<sub>`flows/05-bulk-operations.mmd`</sub>

```mermaid
sequenceDiagram
  autonumber
  actor O as Budget owner
  participant UI as Bulk bar
  participant API as API
  participant DB as PostgreSQL

  O->>UI: select lines, choose operation
  UI->>API: POST /api/lines/bulk {operation, lineIds, ...}
  API->>DB: load all named lines
  API->>API: every line re-authorised individually
  Note over API: a line from another entity<br/>cannot be smuggled into the list
  API->>API: editability per entity (lock, phase, INV-5)
  API->>DB: apply in one transaction
  Note over API,DB: uplift goes through Money,<br/>not a SQL multiply, so rounding<br/>matches everywhere else
  API->>DB: one audit event with the affected count
  API-->>UI: {affected}
```

## Submission & approval state machine

<sub>`flows/06-submission-approval.mmd`</sub>

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> submitted: owner submits<br/>(blocking rules pass)
  submitted --> approved: CFO approves
  submitted --> changes_requested: CFO requests information
  submitted --> draft: CFO rejects
  changes_requested --> submitted: owner resubmits
  approved --> locked: cycle locks
  approved --> approved: edit refused (INV-5)<br/>unless CFO grants an exception
  locked --> [*]
  note right of submitted
    Segregation of duties: the actor who
    submitted can never be the actor who
    decides. Enforced by a CHECK
    constraint, not only in the handler.
  end note
```

## Cost centre lifecycle & segregation of duties

<sub>`flows/07-cost-centre-lifecycle.mmd`</sub>

```mermaid
graph LR
  A(["Admin creates centre"]):::start --> P["pending"]:::ctrl
  P --> CFO{"CFO decision"}
  CFO -->|approve| OK["approved"]:::data
  CFO -->|reject| NO["rejected"]:::ctrl
  A -.->|creator cannot approve<br/>CHECK cost_centre_sod| CFO
  OK --> USE["Selectable on a budget line"]
  NO --> STALE["Existing references stay visible,<br/>flagged red (INV-2)"]:::ctrl
  P --> STALE
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Actuals, elapsed periods and pace

<sub>`flows/08-actuals-consumption.mmd`</sub>

```mermaid
graph TB
  REC(["Record spend"]):::start --> EL{"Period elapsed?<br/>server clock"}:::ctrl
  EL -->|no| R403["403 refused (FR-041)"]:::ctrl
  EL -->|yes| SRC{"Period owned<br/>by the ledger?"}
  SRC -->|yes| R403B["403 — nightly refresh<br/>would overwrite it"]:::ctrl
  SRC -->|no| SAVE["Upsert actual + audit"]:::data
  SAVE --> CALC["Per line: plan, spend to date,<br/>YTD plan, variance, consumed %"]:::data
  CALC --> PACE{"spend > plan x elapsed/periods?"}
  PACE -->|yes| FLAG["Flagged over pace (FR-042)"]:::ctrl
  CALC --> ROLL["Roll up to category,<br/>entity and group (FR-043)"]:::data
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## FX restatement at read time

<sub>`flows/09-fx-restatement.mmd`</sub>

```mermaid
sequenceDiagram
  autonumber
  actor A as Administrator
  participant API as API
  participant DB as PostgreSQL
  participant R as Any report

  A->>API: PUT /api/fx-rates {currency, year, rate}
  API->>DB: upsert rate, audit old -> new
  Note over DB: stored amounts are NOT rewritten
  R->>API: GET /api/reports/consolidation
  API->>DB: read amounts in local currency
  API->>API: convert at read time (NFR-003)
  API-->>R: every derived figure restated consistently
```

## Consolidation & the INV-4 fold

<sub>`flows/10-consolidation-reporting.mmd`</sub>

```mermaid
graph LR
  SCOPE(["visibleEntityIds()"]):::start --> F1["Caller read scope"]:::ctrl
  SCOPE --> F2["Deployment region"]:::ctrl
  F1 & F2 --> IDS["Entity ids"]:::data
  IDS --> LINES["loadLines() one query"]:::data
  LINES --> TOT["computeLineTotals()<br/>FX at read time"]:::data
  TOT --> C["rollUp by category"]:::data
  TOT --> E["rollUp by entity"]:::data
  TOT --> G["group total"]:::data
  C & E & G --> INV["INV-4: both partitions add<br/>back to the same whole"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Capex asset life & depreciation

<sub>`flows/11-capex-depreciation.mmd`</sub>

```mermaid
graph LR
  L(["Capex line"]):::start --> FM{"Finance Manager<br/>approves asset life"}:::ctrl
  FM -->|pending| PROV["Schedule provisional"]:::ctrl
  FM -->|rejected| NONE["No schedule"]:::ctrl
  FM -->|approved| SCH["Straight-line over N years"]:::data
  SCH --> Y["Charge per year"]:::data
  Y --> REM["Final year absorbs the<br/>rounding remainder"]:::ctrl
  REM --> SUM["Schedule sums back to<br/>the capitalised amount"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Allocations & chargeback

<sub>`flows/12-allocations-chargeback.mmd`</sub>

```mermaid
graph LR
  POOL(["Central pool"]):::start --> KEY["Driver key<br/>headcount / sites / devices / stores"]:::data
  KEY --> SHARE["Entity share =<br/>pool x own driver / total driver"]:::data
  SHARE --> VIEW["Own + charged = total"]:::data
  VIEW --> RO["Charged portion is read-only<br/>to the receiving entity (INV-6)"]:::ctrl
  ADMIN(["Administrator"]):::start -.->|only actor who<br/>may edit pools| POOL
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Append-only audit & hash chain

<sub>`flows/13-audit-chain.mmd`</sub>

```mermaid
graph LR
  ACT(["State-changing action"]):::start --> TX["Same transaction"]:::data
  TX --> BIZ["Business write"]:::data
  TX --> AUD["audit_events insert"]:::data
  AUD --> TRG["BEFORE INSERT trigger"]:::ctrl
  TRG --> LOCK["advisory lock:<br/>serialise the chain"]:::ctrl
  LOCK --> HASH["row_hash = sha256(prev_hash || content)"]:::ctrl
  AUD -.->|insert fails| ROLL["Business write rolls back"]:::ctrl
  HASH --> V["audit_verify_chain()<br/>returns first bad seq or null"]:::ctrl
  V --> ALERT["Monitoring alerts on non-null<br/>(ZT-008)"]:::ext
  UPD(["UPDATE / DELETE"]):::ext -.->|revoked grant<br/>+ trigger refusal| X["Refused (FR-073)"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Retention job & data subject rights

<sub>`flows/14-retention-dsr.mmd`</sub>

```mermaid
graph TB
  JOB(["Retention run"]):::start --> FT["free_text 36m:<br/>delete comments"]:::data
  JOB --> IU["inactive_users 24m:<br/>deactivate"]:::data
  JOB --> AUD["audit 84m:<br/>SECURITY DEFINER purge only"]:::ctrl
  AUD --> RE["Re-anchor hash chain<br/>to the surviving head"]:::ctrl
  JOB --> EV["Audit event with counts purged<br/>(PRIV-001)"]:::data
  DSR(["Data subject request"]):::start --> EXP["Export: user record,<br/>own comments, own audit entries"]:::data
  DSR --> PSE["Pseudonymise: email, name and oid<br/>replaced, free text deleted"]:::ctrl
  PSE --> KEEP["Audit events survive and still<br/>hash-link — erasure must not<br/>break the chain (CMP-133)"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Admin backup — encrypt, attest, download

<sub>`flows/15-backup.mmd`</sub>

```mermaid
sequenceDiagram
  autonumber
  actor A as Administrator
  participant API as API
  participant DB as PostgreSQL
  participant S as Encrypted storage

  A->>API: POST /api/admin/backups
  API->>API: capability + step-up + rate limit
  API->>DB: reserve manifest row (status failed)
  loop fixed table allow-list
    API->>DB: select row_to_json(t)
  end
  API->>DB: audit_verify_chain() + head seq
  API->>API: gzip, AES-256-GCM<br/>AAD = backup id : region
  API->>S: write ciphertext (0600)
  API->>DB: manifest: counts, sha256, iv, tag, chain state
  API->>DB: audit event with row count
  API-->>A: manifest
  A->>API: GET /api/admin/backups/:id/download
  API->>API: verify sha256, then GCM tag
  API-->>A: attachment, audited separately
```

## XLSX export & formula-injection guard

<sub>`flows/16-export-xlsx.mmd`</sub>

```mermaid
graph LR
  REQ(["GET export.xlsx"]):::start --> CAP["budget.view.any<br/>+ 5 per 5 minutes"]:::ctrl
  CAP --> SCOPE["Scoped + region-filtered lines"]:::data
  SCOPE --> CELL{"Cell kind"}
  CELL -->|number| NUM["Money decimal string"]:::data
  CELL -->|text| ESC["Leading = + - @ tab CR<br/>prefixed with an apostrophe"]:::ctrl
  ESC --> XML["XML-escaped inline string"]:::data
  NUM & XML --> ZIP["OOXML zip, no library"]:::data
  ZIP --> DL["Content-Disposition attachment<br/>nosniff, fixed filename"]:::ctrl
  DL --> AUD["Audited with line and entity count"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Residency routing (CMP-140)

<sub>`flows/17-residency-routing.mmd`</sub>

```mermaid
graph TB
  U(["Any read"]):::start --> RES["visibleEntityIds(request, region)"]:::ctrl
  RES --> S1["Caller read scope<br/>own entities or all"]:::ctrl
  RES --> S2["entities.residency = deployment region"]:::ctrl
  S1 & S2 --> OUT["Entity ids"]:::data
  OUT --> EU["EU deployment serves eu rows"]:::data
  X1["ch rows"]:::ext -.->|404| EU
  X2["apac rows"]:::ext -.->|404| EU
  X3["cn rows"]:::ext -.->|404 even for admin<br/>CMP-140| EU
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

# User journeys

What each role actually does, in the order they do it.

## Budget owner

<sub>`flows/user-01-budget-owner.mmd`</sub>

```mermaid
journey
  title Budget owner — build and submit a budget
  section Prepare
    Sign in with Entra ID: 4: Owner
    Open Budget entry for my entity: 5: Owner
    Review validation warnings: 3: Owner
  section Build
    Type quarterly amounts: 4: Owner
    Open a line, add justification: 4: Owner
    Select lines, apply an uplift: 5: Owner
    Fix cost-centre exceptions: 2: Owner
  section Track
    Record spend for elapsed quarters: 4: Owner
    Check over-pace lines in Actuals: 3: Owner
  section Submit
    Submit for review: 5: Owner
    Read the CFO decision and comment: 3: Owner
    Resubmit after changes: 4: Owner
```

## CFO

<sub>`flows/user-02-cfo.mmd`</sub>

```mermaid
journey
  title CFO — review and decide
  section Survey
    Open Consolidation, read the group total: 5: CFO
    Check submission status per entity: 4: CFO
  section Review
    Open a submission card: 4: CFO
    Read flags: threshold, pace, cost centre: 3: CFO
    Approve or reject individual lines: 4: CFO
    Approve all lines at once: 5: CFO
  section Decide
    Approve, reject, or request information: 5: CFO
    Write the comment returned to the owner: 4: CFO
  section Govern
    Approve or reject cost centres: 4: CFO
    Move the cycle phase, set the lock date: 3: CFO
    Grant a late-edit exception: 2: CFO
    Read the full audit trail: 4: CFO
```

## Administrator (Group IT Finance)

<sub>`flows/user-03-administrator.mmd`</sub>

```mermaid
journey
  title Administrator — run the cycle
  section Template
    Define fields, order, required, visible: 4: Admin
    Set the approval threshold: 4: Admin
    Manage cost categories: 3: Admin
  section Organisation
    Create entities and assign owners: 4: Admin
    Create cost centres for CFO approval: 3: Admin
    Maintain FX rates: 4: Admin
    Edit allocation pools: 3: Admin
  section Governance
    Classify fields, set retention: 3: Admin
    Run the retention job: 2: Admin
    Handle a data subject request: 2: Admin
    Verify the audit chain: 5: Admin
  section Operations
    Run a backup: 5: Admin
    Export the consolidation: 5: Admin
```

## Finance Manager — the dual role

<sub>`flows/user-04-finance-manager.mmd`</sub>

```mermaid
journey
  title Finance Manager — the dual role
  section As a budget owner
    Build and submit my own entity: 4: FinanceMgr
    Record spend: 4: FinanceMgr
  section As a cycle co-owner
    Move the cycle phase: 3: FinanceMgr
    Set or clear the submission lock date: 3: FinanceMgr
    Grant a late-edit exception: 2: FinanceMgr
    Toggle validation rules: 3: FinanceMgr
  section Capex authority
    Approve or reject an asset life: 5: FinanceMgr
    Confirm the depreciation schedule: 4: FinanceMgr
```

# Software-development interaction

How the pieces interact at build, test, run and deploy.

## Change lifecycle — requirement to merge

<sub>`flows/dev-01-change-lifecycle.mmd`</sub>

```mermaid
graph LR
  REQ(["Requirement ID<br/>FR / SEC / ZT / PRIV"]):::start --> BR["Branch"]
  BR --> CODE["Code + comment naming the ID"]
  CODE --> TEST["Test that fails if the<br/>control is removed"]:::ctrl
  TEST --> PR["Pull request"]
  PR --> GATE["CI gates"]:::ctrl
  GATE --> REV["Review against the<br/>definition of done"]
  REV --> MERGE["Merge"]
  MERGE --> ADR{"Decision worth<br/>recording?"}
  ADR -->|yes| DOC["ADR in docs/adr"]:::data
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## CI gates

<sub>`flows/dev-02-ci-gates.mmd`</sub>

```mermaid
graph TB
  PR(["Pull request"]):::start --> TC["typecheck"]:::ctrl
  PR --> LINT["eslint<br/>incl. no concatenated SQL,<br/>no dangerouslySetInnerHTML"]:::ctrl
  PR --> AUD["npm audit high, prod deps"]:::ctrl
  PR --> BUILD["vite build"]:::ctrl
  PR --> TEST["vitest: authz matrix, security,<br/>invariants, a11y, operations"]:::ctrl
  PR --> SBOM["CycloneDX SBOM artefact"]:::data
  PR --> SAST["CodeQL security-extended"]:::ctrl
  PR --> SEC["gitleaks over full history"]:::ctrl
  PR --> CONF["Refuse any import of the<br/>confidential workbook"]:::ctrl
  TC & LINT & AUD & BUILD & TEST & SAST & SEC & CONF --> M{"All green?"}
  M -->|no| BLOCK["Merge blocked"]:::ctrl
  M -->|yes| OK["Mergeable"]:::data
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Seed data & anonymisation boundary

<sub>`flows/dev-03-seed-anonymise.mmd`</sub>

```mermaid
graph LR
  RAW(["design/budget-data.js<br/>Confidential"]):::ext --> TOOL["tools/anonymise.ts<br/>offline only"]:::ctrl
  TOOL --> R1["Discard names and free text"]:::ctrl
  TOOL --> R2["Jitter then round amounts"]:::ctrl
  TOOL --> R3["Shuffle order"]:::ctrl
  TOOL --> R4["Report singleton classes"]:::ctrl
  R1 & R2 & R3 & R4 --> FIX["db/fixtures/anonymised.json<br/>Internal, gitignored"]:::data
  FIX --> DS{"SEED_MODE"}
  SYN["syntheticDataset()"]:::data --> DS
  DS --> LOADER["One loader, one Dataset"]:::data
  LOADER --> DB[("PostgreSQL")]:::data
  RAW -.->|CI refuses any import<br/>from packages/ or test/| X["Blocked"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Test strategy

<sub>`flows/dev-04-test-strategy.mmd`</sub>

```mermaid
graph TB
  T(["360 tests"]):::start --> A["authz.test.ts<br/>every role x every capability"]:::ctrl
  T --> S["security.test.ts<br/>XSS, SQLi, CSRF, IDOR, headers,<br/>formula injection, config"]:::ctrl
  T --> I["invariants.test.ts<br/>INV-1..6, money, FX, concurrency"]:::ctrl
  T --> Y["a11y.test.ts<br/>axe in a real browser + contrast"]:::ctrl
  T --> O["operations.test.ts<br/>anonymiser, seed modes, backup"]:::ctrl
  A & S & I & Y & O --> PG[("Real PostgreSQL<br/>throwaway DB per run")]:::data
  PG --> WHY["Constraints, triggers and grants<br/>are half the controls — a mock<br/>would only test the mock"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Runtime topology (target)

<sub>`flows/dev-05-runtime-topology.mmd`</sub>

```mermaid
graph TB
  subgraph edge["Public edge"]
    FD["Azure Front Door + WAF<br/>TLS 1.3 termination"]:::ext
  end
  subgraph private["Private network — no public ingress"]
    API["Container App: Spendifre API<br/>serves SPA shell + REST"]:::data
    PG[("Azure Database for PostgreSQL<br/>TLS verify-full, CMK at rest")]:::data
    BLOB[("Blob: backups<br/>CMK + immutability")]:::data
    KV["Key Vault<br/>DB creds, backup key, client secret"]:::ctrl
  end
  ENTRA["Microsoft Entra ID"]:::ext
  SIEM["SIEM / OTLP backend"]:::ext
  FD --> API
  API -->|workload identity| PG
  API -->|workload identity| BLOB
  API -->|managed identity| KV
  API -->|OIDC + PKCE| ENTRA
  API -->|auth, denials, admin actions| SIEM
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

## Local development

<sub>`flows/dev-06-local-dev.mmd`</sub>

```mermaid
graph LR
  A(["npm ci"]):::start --> B["createdb spendifre"]
  B --> C["npm run db:migrate<br/>as the migrator role"]:::ctrl
  C --> D["npm run db:seed<br/>SEED_MODE=synthetic"]:::data
  D --> E["npm run build (web)"]
  E --> F["npm run dev<br/>DEV_AUTH=on"]:::ctrl
  F --> G["Sign in as any persona<br/>admin@ cfo@ finance@ ..."]
  F -.->|loadConfig refuses<br/>DEV_AUTH in production| H["Fails to start"]:::ctrl
  classDef start fill:#0f9f76,stroke:#0b7a5a,color:#ffffff,font-weight:600;
  classDef ctrl fill:#fdf0e3,stroke:#b45309,color:#7a3908;
  classDef data fill:#e9f6f1,stroke:#0b7a5a,color:#08402f;
  classDef ext fill:#eef2f7,stroke:#55647c,color:#22303f;
```

# Handoff: Spendifre — Birgma / Biltema Group IT budget platform

## Overview

Spendifre is the group's IT budget platform. Group IT Finance defines the budget template,
budget owners fill in their unit's lines, the CFO signs it off line by line, and the group
consolidates 21 entities in EUR. It replaces a 25-sheet Excel workbook (`2026 IT budget
consolidated FINAL.xlsx`), whose real FY2026 figures are carried in `budget-data.js`.

Three actor families, each with a different job:

- **Administrator (Group IT Finance)** — template, categories, entities, FX rates, cost centres,
  approval workflow, reminders, data governance.
- **Budget owner** — seven manager personas. Fills in lines, records spend, submits.
- **CFO** — reviews every submission, decides per line, validates cost centres, owns the cycle.

## About the design files

**The files in this bundle are design references written in HTML, not production code.** They
are prototypes that show intended layout and behaviour. Do not lift the markup: the styling is
inline throughout, which will not survive the Content Security Policy the spec requires
(`SEC-032`), and there is no backend, auth, or persistence behind any of it.

The task is to **recreate these designs in the target codebase** using its established framework,
component library and patterns. If no codebase exists yet, choose the stack — `SPEC.md` §2
records the intended shape (TypeScript, React, SSR, PostgreSQL, Entra ID, Azure) as a starting
point, and asks you to log the decision as an ADR.

**`SPEC.md` is the contract, not this README.** (Rename it to `CLAUDE.md` at the root of the
target repo so Claude Code picks it up automatically.) It is written for Spec Driven Development:
every behaviour is a numbered, testable requirement (`FR-`, `SEC-`, `ZT-`, `PRIV-`, `NFR-`,
`A11Y-`, `CMP-`), with invariants, a normative permission matrix, and a definition of done. Work
the loop it describes — specify → plan → tasks → implement → verify. Where this README and
`SPEC.md` disagree, `SPEC.md` wins.

## Fidelity

**High fidelity.** Final colours, type, spacing and interaction behaviour. Recreate the UI
faithfully using the codebase's own primitives.

Two deliberate exceptions:

1. **Type scale is too small and must not be reproduced as-is.** Body text runs 9.5–11px. The
   spec (`A11Y-001`) requires a 14px minimum, 4.5:1 text contrast, 3:1 for UI components, and a
   non-colour cue beside every status colour. Rebuild the density at accessible sizes rather than
   matching the screenshots pixel for pixel.
2. **The role switcher and persona dropdown are demo affordances.** In production, identity and
   role come from Entra ID group membership (`SPEC.md` §4). There is no role picker.

## Design tokens

Dark is the default; light is a supported variant. Both are defined as CSS custom properties on
the root element of `Budget Tool.dc.html`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0a0e17` | `#f3f6f8` | App background |
| `--panel` | `#0c111e` | `#ffffff` | Cards, tables, sidebar |
| `--sunk` | `#141d2e` | `#eaeef3` | Inputs, segmented controls |
| `--band` | `#0f1524` | `#eef2f6` | Category header rows |
| `--hover` | `#111a2b` | `#f7fafc` | Row hover |
| `--line` | `#1a2335` | `#dde3ea` | All borders and rules |
| `--text` | `#e6edf7` | `#0c111e` | Primary text |
| `--dim` | `#7d8ca6` | `#5f6f88` | Secondary text, labels |
| `--accent` | `#34d399` | `#0f9f76` | Actions, focus, positive |
| `--accentDeep` | `#0f9f76` | `#0f9f76` | Gradient end on primary buttons |
| `--accentSoft` | `accent @ 15%` | `accent @ 12%` | Selected rows, chips |
| `--onAccent` | `#04231a` | `#04231a` | Text on accent fills |
| `--warn` | `#f0b357` | `#b45309` | Pending, warnings |
| `--danger` | `#f2776b` | `#b42318` | Rejected, over budget, increases |

Delta convention: **increases are `--danger`, decreases are `--accent`** — this is a cost tool,
so growth is the bad direction. Under ±2% renders in `--dim`.

Category colours (fixed, used in charts and legends): Travel `#f0b357` · Consultancies `#34d399`
· Computer communication `#38bdf8` · Short term equipment `#a78bfa` · Training `#fb923c` ·
Licenses `#22d3ee` · Other `#7d8ca6` · Investments `#f472b6`.

**Type.** Space Grotesk 600–700 for the wordmark, page titles and KPI figures. IBM Plex Sans
400–600 for all body and UI text. JetBrains Mono 400–500 for every number, code, currency and
timestamp — money is always monospaced so columns align.

**Login page** uses its own palette: navy gradient `#0B0F2C → #11163A → #132A5E` on the brand
panel, `#EEF1F6` on the form side, Public Sans for body, Space Grotesk for headings.

**Geometry.** Radius 6px on controls, 7px on primary buttons, 9px on panels, 11–14px on login
cards. Borders are always 1px `--line`. Row padding 6–7px vertical, 13px horizontal. Panel
header padding 10px 13px. Gaps 8–10px in tables, 14px between panels, 16px page padding.
Primary buttons are a 135° `accent → accentDeep` gradient with `--onAccent` text.

## Screens

25 reference screenshots are in `docs/screenshots/`, with `README.md` mapping every file to its
screen. They are the visual contract; read them alongside `SPEC.md` §6.

**Shell** — 214px fixed sidebar (wordmark, role tabs, persona select, nav, user footer with
theme toggle), then a header (title, subtitle, EUR/Local toggle, page actions), then the scrolling
view. An optional 314px right drawer opens for line detail.

| Area | Requirements | Screenshot |
|---|---|---|
| Entra ID sign-in, MFA, role resolution | §4, `ZT-002` | `01`–`03` |
| Budget entry grid | `FR-010`–`FR-016` | `10`, `12` |
| Line detail drawer | `FR-012`, `FR-021` | `11` |
| Actuals & consumption | `FR-041`–`FR-044` | `13`, `24` |
| Five-year trend, breakdown, plotting | `FR-061` | `14`, `15` |
| Drivers, formulas, headcount toggle | `FR-020`–`FR-022` | `16` |
| Capex depreciation | `FR-030`–`FR-032` | `17` |
| CFO submission review, per line | `FR-052`, `FR-053` | `20`, `21` |
| Cost centre registry | `FR-013`, `SEC-012` | `22` |
| Cycle, lock date, validation rules | `FR-055`–`FR-057` | `23` |
| Consolidation | `FR-060` | `30` |
| Template builder | `FR-001`–`FR-004` | `31` |
| Workflow stages & reminders | `FR-051`, `FR-054` | `32` |
| Audit trail | `FR-070`–`FR-073` | `33`, `40` |
| Data classification & retention | §9, `PRIV-001`–`003` | `34` |
| Entities, owners, FX rates | `FR-014`, §5 | `35` |
| Allocations & chargeback | `FR-023` | `36` |
| FX rate history | `FR-063` | `37` |
| Variance | `FR-062` | `38` |

## Behaviour worth calling out

These are the parts most likely to be rebuilt wrongly:

- **Aggregates are summed from the line level, never modelled at the parent.** Every trend,
  category and group figure is the sum of its children in every year (`INV-4`, `NFR-004`). An
  earlier prototype build derived parents independently and the numbers stopped reconciling.
- **A row never mixes currencies.** Every money column in a row renders in the selected unit; the
  line's currency code is shown; typing in EUR converts back to local before storage (`FR-014`).
- **Driver-linked amounts are computed, not stored.** Quarter inputs go read-only, and the line
  shows its expression. Turning headcount planning off makes headcount-linked lines dormant, not
  deleted (`INV-3`, `FR-022`).
- **Cost centre is a constrained choice over approved centres only.** A line already booked to a
  rejected or pending centre keeps showing it in red rather than silently clearing (`INV-2`).
- **Managers see only their own audit events**, filtered in the query and never merely hidden
  (`FR-071`).
- **Only elapsed periods accept recorded spend**, and a line consuming faster than time elapsed
  is flagged (`FR-041`, `FR-042`).
- **Approved budgets are immutable**; reopening needs a CFO or Finance Manager exception and
  writes an audit event (`INV-5`, `FR-056`).

## State

The prototype holds everything in one component's state. Production must move all of it server
side and re-derive identity, role, entity scope and money from the session on every request
(`SPEC.md` §0, `SEC-010`, `SEC-011`). The shapes worth carrying over: `edits` and `actualEdits`
keyed `lineId:period`; `formulas` keyed by line; `ccDecisions`; `lineDecisions`; `statusOverride`
per entity; `auditLog` append-only; `classifications` and `retention`.

Note `FR-080`: versions and scenarios are deferred, but amounts should be addressable by
`(line, period, version)` from day one so adding them later is not a rewrite.

## Assets

- `assets/birgma-logo-trim.png`, `assets/biltema-logo-trim.png` — group logos, used on the login
  co-brand lockup. Replace with whatever the codebase already has.
- The Spitfire mark is an inline SVG side-profile silhouette drawn for this project, authored for
  legibility at 22–36px. It is in the `<helmet>`-adjacent markup of both HTML files.
- No icon library. Nav glyphs are unicode characters; replace them with the codebase's icon set
  and give every icon control a screen-reader label (`A11Y-001`).

## Data

`budget-data.js` holds the real workbook extract: 21 entities, ~480 line items with quarterly
plans and local currencies, and the FY26 FX table. **Treat it as `Confidential` commercial data**
(`PRIV-010`) — it is not synthetic seed data, and it must not go into a public repo or a shared
test fixture. Vendor names, cost centres, GL accounts, Capex/Opex flags, owners and statuses in
the prototype ARE synthetic; the workbook does not carry them.

Prior-year figures are modelled from a per-line growth factor, not booked actuals. Replace with
ledger data (`FR-040`) and keep the summation property under test.

## Files

| File | What it is |
|---|---|
| `SPEC.md` | **The specification.** Start here; rename to `CLAUDE.md` in the target repo. |
| `Budget Tool.dc.html` | Whole product, all roles, all screens |
| `Budget Login.dc.html` | Entra ID sign-in flow (visual only) |
| `budget-data.js` | Real FY2026 workbook extract — confidential |
| `docs/screenshots/` | 25 reference screenshots + index |
| `assets/` | Group logos |
| `support.js` | Prototype runtime. Not part of the design; do not port. |

## Open decisions blocking architecture

From `SPEC.md` §12 — two of these need answers from Legal before hosting is chosen:

1. **China PIPL data localisation** (`CMP-140`) — the workbook spans CNY, HKD, TWD, VND, IDR,
   THB, MYR, PHP, INR, BDT, LKR, KRW and LAK. A single global tenant is likely not lawful.
2. **NIS2 applicability** (`CMP-120`) — probably out of scope by sector, but obligations commonly
   arrive contractually through the supply chain.
3. Ledger integration for actuals (`FR-040`), Entra group model, and whether the CFO may edit
   figures directly (the prototype says no).

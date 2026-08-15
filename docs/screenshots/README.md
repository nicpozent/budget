# Spendifre — screen reference

Captured from the working prototype at 924×540 in the preview pane. Native `<select>` elements
were flattened to their selected value before capture, so every dropdown in these images shows
its real bound value rather than its first option. Filenames are grouped by
actor so the numbering matches the order a reviewer would walk the product.

The prototype's role switcher (Admin / Manager / CFO tabs, plus a manager-persona dropdown) is a
demo affordance only. In the real system, identity and role come from Microsoft Entra ID group
membership — see `CLAUDE.md`.

## Sign-in — `Budget Login.dc.html`

| File | Screen |
|---|---|
| `01-login-entra-idle.png` | Landing page, Entra ID single sign-on |
| `02-login-mfa-number-match.png` | Number-matching MFA challenge |
| `03-login-role-picker.png` | Post-auth role selection (demo only; production reads Entra groups) |

## Manager — `Budget Tool.dc.html`

| File | Screen |
|---|---|
| `10-manager-budget-grid.png` | Budget entry grid: categories, quarterly phasing, live totals and vs-2025 deltas |
| `11-manager-line-drawer.png` | Line side panel: every template field, driver link, phasing, justification, comment thread |
| `12-manager-bulk-operations.png` | Multi-select bulk bar: uplift %, copy last year, move cost centre, delete |
| `13-actuals-manager-consumption.png` | Recording spend per line per quarter; burn against pace, lines running over |
| `14-trend-total.png` | Five-year trend with entity filter and Total / By category / Top lines modes |
| `15-trend-breakdown-exploded.png` | Category exploded to its lines; clicking a line plots it on the chart |
| `16-drivers-and-formulas.png` | Volume drivers, headcount planning toggle, driver-linked lines |
| `17-capex-depreciation.png` | Straight-line schedules, entity filter, per-year totals |
| `40-manager-my-activity-scoped.png` | Audit trail scoped to the signed-in manager's own actions only |

## CFO

| File | Screen |
|---|---|
| `20-cfo-submission-cards.png` | One card per submission with flags and decision actions |
| `21-cfo-line-by-line-review.png` | Card expanded: per-line approve / reject / more info, plus Approve all lines |
| `22-cfo-cost-centre-registry.png` | Cost centre validation — managers may only book to approved centres |
| `23-cfo-cycle-and-rules.png` | Cycle phase, submission lock date, late-edit exceptions, validation rules |
| `24-cfo-actuals-filtered.png` | Consumption filtered by entity / budget / manager; quarter inputs read-only for the CFO |

## Administrator (Group IT Finance)

| File | Screen |
|---|---|
| `30-admin-consolidation.png` | Group position, unit submission status, category split |
| `31-admin-template-builder.png` | Field definition: rename, reorder, require, hide; period granularity; threshold |
| `32-admin-workflow-reminders.png` | Approval stages and in-app reminders |
| `33-admin-audit-trail.png` | Append-only record of every action across all entities and roles |
| `34-admin-data-governance.png` | Field classification, retention periods, data subject actions, residency |
| `35-admin-entities-and-fx.png` | Entity create/remove, owners, editable FX rates |
| `36-allocations-chargeback.png` | Central pools charged out to entities on a driver key |
| `37-fx-rate-history.png` | 2022–2026 rates per currency with EUR impact and volatility |
| `38-variance.png` | 2026 vs 2025 movements by line and by category |

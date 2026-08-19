import type { Capability, Role } from '@spendifre/shared';

export type { Capability, Role };

export interface Me {
  /** ZT-004 / WCAG 2.2.1 deadlines, so the client can warn before expiry. */
  session: { idleDeadline: string; absoluteDeadline: string; warnSecondsBefore: number };
  user: {
    id: string;
    displayName: string;
    email: string;
    role: Role;
    /** UI language (NFR-010), stored per user. */
    locale: string;
    ownedEntityIds: string[];
  };
  fiscalYear: number;
  region: string;
}

export interface Entity {
  id: string;
  code: string;
  name: string;
  currency: string;
  state: string;
  deadline: string | null;
  residency: string;
  /** ISO 3166-1 alpha-2. The bucket above is derived from it. */
  country: string;
  countryName: string;
  ownerName: string;
}

export interface Category {
  id: string;
  name: string;
  costType: string;
  position: number;
}

export interface Cycle {
  fiscal_year: number;
  phase: string;
  granularity: string;
  lock_date: string | null;
  lock_enabled: boolean;
  headcount_planning: boolean;
  approval_threshold_eur: string;
}

export interface CostCentre {
  id: string;
  code: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface BudgetLine {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  vendor: string | null;
  costCentreId: string | null;
  costCentreCode: string | null;
  costCentreException: boolean;
  costCentreStatus: string | null;
  glAccount: string | null;
  costType: string;
  currency: string;
  justification: string | null;
  driverKey: string | null;
  driverRatePerUnit: string | null;
  driverValue: number | null;
  dormant: boolean;
  computed: boolean;
  assetLifeYears: number | null;
  assetLifeStatus: string | null;
  version: number;
  periodsLocal: string[];
  totalLocal: string;
  totalEur: string;
  actualLocal: string;
  actualEur: string;
  aboveThreshold: boolean;
  overPace: boolean;
  complete: boolean;
}

export interface BudgetView {
  cycle: Cycle;
  periods: number;
  lines: BudgetLine[];
  categoryTotals: { categoryId: string; plan: string; actual: string }[];
  entityTotal: { plan: string; actual: string };
  elapsedPeriods: number;
}

export interface AuditEvent {
  id: string;
  occurred_at: string;
  action: string;
  target_type: string;
  target_id: string | null;
  entity_id: string | null;
  detail: string;
  kind: string;
  actor_role: string;
  actor_name: string;
}

export interface Submission {
  id: string;
  entityId: string;
  entityCode: string;
  entityName: string;
  fiscalYear: number;
  state: string;
  submittedAt: string;
  submittedBy: string;
  comment: string | null;
  linesApproved: string;
  linesRejected: string;
}

export interface Consolidation {
  total: string;
  actual: string;
  entities: { id: string; code: string; name: string; state: string; plan: string; actual: string }[];
  categories: { id: string; name: string; plan: string }[];
  countries: { code: string; name: string; plan: string; actual: string }[];
}

export interface Consumption {
  showFilters: boolean;
  kpis: {
    plan: string;
    actual: string;
    ytdPlan: string;
    variance: string;
    elapsedPeriods: number;
    totalPeriods: number;
  } | null;
  lines: {
    id: string;
    name: string;
    entityCode: string;
    categoryName: string;
    currency: string;
    plan: string;
    actual: string;
    ytdPlan: string;
    variance: string;
    overPace: boolean;
  }[];
  categories: { name: string; plan: string; actual: string }[];
}

export interface Variance {
  lines: {
    id: string;
    name: string;
    categoryName: string;
    entityCode: string;
    current: string;
    prior: string;
    delta: string;
    direction: 'increase' | 'decrease' | 'flat';
  }[];
  categories: { id: string; name: string; current: string; prior: string; delta: string }[];
}

export interface RuleViolation {
  code: string;
  description: string;
  severity: 'blocking' | 'warning';
  lineIds: string[];
}

/** FR-061. `total` and each series are keyed by fiscal year. */
export interface Trend {
  years: number[];
  total: Record<number, string>;
  series: { id: string; label: string; values: Record<number, string> }[];
}

/** FR-063. */
export interface FxHistory {
  currency: string;
  history: { year: number; rate: string }[];
  drift: string;
}

/** FR-023. `chargedReadOnly` carries INV-6 to the client as data, not styling. */
export interface Allocations {
  pools: { name: string; amount: string; currency: string; driverKey: string }[];
  entities: {
    id: string;
    code: string;
    own: string;
    charged: string;
    total: string;
    chargedReadOnly: boolean;
  }[];
}

/** Runtime self-test (row 14). Mirrors services/selftest.ts. */
export interface SelfTestReport {
  startedAt: string;
  durationMs: number;
  region: string;
  fiscalYear: number;
  summary: { pass: number; fail: number; warn: number; skipped: number };
  /** False if any check failed. Warnings do not make a system unhealthy. */
  healthy: boolean;
  checks: {
    id: string;
    title: string;
    requirement: string;
    status: 'pass' | 'fail' | 'warn' | 'skipped';
    detail: string;
    durationMs: number;
  }[];
}

/** FR-080 budget versions and scenarios. Mirrors services/versions.ts. */
export interface BudgetVersionSummary {
  fiscalYear: number;
  key: string;
  label: string;
  kind: 'working' | 'baseline' | 'scenario' | 'forecast';
  description: string | null;
  locked: boolean;
  copiedFrom: string | null;
  createdByName: string | null;
  createdAt: string;
  lockedAt: string | null;
  amountCount: number;
}

export interface VersionList {
  fiscalYear: number;
  versions: BudgetVersionSummary[];
}

export interface ComparisonRow {
  key: string;
  label: string;
  base: string;
  against: string;
  delta: string;
}

export interface VersionComparison {
  base: string;
  against: string;
  total: ComparisonRow;
  entities: ComparisonRow[];
  categories: ComparisonRow[];
}

/** FR-020 driver definitions. `value` is resolved; `terms` is the definition. */
export interface DriverTermInput {
  derivedFrom: string;
  factor: string;
}

export interface Driver {
  id: string;
  entityId: string;
  driverKey: string;
  unit: string;
  value: number;
  terms: DriverTermInput[];
}

/** FR-051. `position` is the order in the chain; the list arrives sorted by it. */
export interface ApprovalStage {
  id: string;
  position: number;
  name: string;
  requiredRole: string;
  minAmountEur: string;
  enabled: boolean;
}

/**
 * FR-005. `entityCount` is how many budgets started on this version and stay
 * pinned to it — the promise publishing makes, as a number.
 */
export interface TemplateVersion {
  id: string;
  version: number;
  state: 'draft' | 'published';
  note: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  fieldCount: string;
  entityCount: string;
}

export interface TemplateField {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  visible: boolean;
  position: number;
}

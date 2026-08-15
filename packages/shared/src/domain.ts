/** Domain vocabulary from SPEC §3. Types only — no behaviour, no I/O. */

export const CURRENCIES = [
  'EUR', 'SEK', 'NOK', 'DKK', 'CHF', 'GBP', 'USD', 'PLN', 'TRY', 'CZK',
  'INR', 'CNY', 'HKD', 'TWD', 'VND', 'IDR', 'THB', 'MYR', 'PHP', 'SGD',
  'JPY', 'KRW', 'BDT', 'LKR', 'LAK', 'AUD', 'ILS',
] as const;
export type Currency = (typeof CURRENCIES)[number];

export const COST_TYPES = ['opex', 'capex'] as const;
export type CostType = (typeof COST_TYPES)[number];

export const COST_CENTRE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CostCentreStatus = (typeof COST_CENTRE_STATUSES)[number];

/** FR-050. `locked` is terminal for the cycle; `changes_requested` returns to the owner. */
export const BUDGET_STATES = [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'locked',
] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

/** FR-055 */
export const CYCLE_PHASES = ['collection', 'review', 'locked', 'reforecast'] as const;
export type CyclePhase = (typeof CYCLE_PHASES)[number];

/** FR-053 */
export const LINE_DECISIONS = ['approved', 'rejected', 'info_requested'] as const;
export type LineDecision = (typeof LINE_DECISIONS)[number];

/** FR-070 */
export const AUDIT_KINDS = ['change', 'approval', 'workflow', 'governance'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** SPEC §9.1 — every field carries exactly one. */
export const DATA_CLASSES = ['public', 'internal', 'confidential', 'personal_data'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** FR-001 */
export const FIELD_TYPES = ['text', 'select', 'money', 'note', 'file'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** FR-002 */
export const GRANULARITIES = ['quarterly', 'monthly'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * FR-080 (deferred). Amounts are addressable by (line, period, version) from
 * day one; v1 only ever writes 'working'. Adding scenarios later is a data
 * migration, not a rewrite.
 */
export const WORKING_VERSION = 'working';

/** FR-020 */
export const DRIVER_KEYS = ['headcount', 'sites', 'devices', 'stores'] as const;
export type DriverKey = (typeof DRIVER_KEYS)[number];

/** FR-057 */
export const RULE_SEVERITIES = ['blocking', 'warning'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export interface Entity {
  id: string;
  code: string;
  name: string;
  currency: Currency;
  ownerUserId: string | null;
  deadline: string | null;
  state: BudgetState;
  /** SPEC §9.4 — drives which regional deployment may hold the row. */
  residency: 'eu' | 'ch' | 'apac' | 'cn';
}

export interface Category {
  id: string;
  name: string;
  costType: CostType;
  position: number;
}

export interface CostCentre {
  id: string;
  code: string;
  description: string;
  status: CostCentreStatus;
  createdByUserId: string;
  approvedByUserId: string | null;
}

export interface LineItem {
  id: string;
  entityId: string;
  categoryId: string;
  name: string;
  vendor: string | null;
  costCentreId: string | null;
  glAccount: string | null;
  costType: CostType;
  currency: Currency;
  justification: string | null;
  driverKey: DriverKey | null;
  /** Decimal string. Present only when driverKey is set (INV-3). */
  driverRatePerUnit: string | null;
  assetLifeYears: number | null;
  assetLifeApproved: boolean | null;
  /** Optimistic concurrency token (NFR-005). */
  version: number;
}

export interface PeriodAmount {
  lineId: string;
  /** 1-4 for quarterly, 1-12 for monthly. */
  period: number;
  /** FR-080 version dimension. */
  budgetVersion: string;
  /** Decimal string in the line's local currency. */
  amount: string;
}

export interface FxRate {
  currency: Currency;
  fiscalYear: number;
  /** Decimal string: units of EUR per 1 unit of `currency`. */
  rate: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  entityId: string | null;
  detail: string;
  kind: AuditKind;
}

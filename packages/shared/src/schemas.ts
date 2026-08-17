/**
 * Boundary validation (SEC-022). Every request input is validated against one
 * of these before a handler sees it. Allow-list only: each schema states what
 * is acceptable and everything else is rejected.
 *
 * Note on free text: these schemas do NOT strip or escape HTML. Input
 * filtering is a deny-list and the spec prohibits that approach; XSS is
 * defended by context-aware output encoding (SEC-030) so that a justification
 * legitimately containing `<` survives round-tripping and still renders inert.
 * What we do constrain here is length and control characters, because those are
 * denial-of-service and log-injection vectors rather than XSS vectors.
 */

import { z } from 'zod';
import { Money } from './money.ts';
import {
  AUDIT_KINDS,
  BUDGET_STATES,
  COST_TYPES,
  CURRENCIES,
  CYCLE_PHASES,
  DATA_CLASSES,
  DRIVER_KEYS,
  FIELD_TYPES,
  GRANULARITIES,
  LINE_DECISIONS,
  RULE_SEVERITIES,
} from './domain.ts';

/** C0/C1 control characters other than tab and newline. */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Single-line free text: no newlines, no controls, bounded. */
export const shortText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(max, `must be at most ${max} characters`)
    .refine((s) => !CONTROL_CHARS.test(s) && !s.includes('\n'), {
      message: 'must not contain control characters',
    });

/** Multi-line free text: newlines and tabs allowed, other controls are not. */
export const longText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `must be at most ${max} characters`)
    .refine((s) => !CONTROL_CHARS.test(s), {
      message: 'must not contain control characters',
    });

export const uuid = z.string().uuid('must be an opaque identifier');

/**
 * A money amount on the wire. Parsed through `Money` so `NaN`, `Infinity`,
 * exponent notation and excess precision are all rejected here rather than
 * reaching the database as a silently coerced value.
 */
export const moneyString = z
  .string()
  .max(32)
  .superRefine((value, ctx) => {
    try {
      Money.parse(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'invalid amount',
      });
    }
  });

/**
 * A plain decimal with an explicit maximum scale, validated without throwing.
 *
 * This exists separately from `moneyString` because a *rate* is not an amount.
 * Money is fixed at 4 decimal places; an FX rate needs 8 — the workbook spans
 * VND (0.0000363), LAK (0.0000396) and KRW (0.000607), all of which round to
 * zero or lose most of their significance at 4. The `fx_rates.rate` column is
 * `numeric(18,8)` for exactly this reason, and the boundary schema has to agree
 * with the column or the currencies simply cannot be administered.
 *
 * Note the absence of `Money.parse` here. A `.refine` callback that throws
 * propagates the exception instead of producing a validation issue, which turns
 * a 422 into a 500 — the caller's malformed input becomes our error. Validation
 * predicates must return false, never throw.
 */
const DECIMAL_WITH_SCALE = (maxScale: number) =>
  z
    .string()
    .trim()
    .max(32)
    .refine((v) => /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v), {
      message: 'must be a plain decimal',
    })
    .refine(
      (v) => {
        const fraction = v.split('.')[1];
        return fraction === undefined || fraction.length <= maxScale;
      },
      { message: `must have at most ${maxScale} decimal places` },
    );

/** A non-negative rate, e.g. FX or a driver rate per unit. */
export const rateString = DECIMAL_WITH_SCALE(8).refine((v) => !v.startsWith('-'), {
  message: 'rate must not be negative',
});

export const percentString = z
  .string()
  .max(16)
  .superRefine((value, ctx) => {
    try {
      const pct = Money.parse(value);
      const limit = Money.parse('1000');
      if (pct.compare(limit) > 0 || pct.compare(limit.negate()) < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'percentage out of range' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid percentage' });
    }
  });

export const currency = z.enum(CURRENCIES);
export const costType = z.enum(COST_TYPES);
export const budgetState = z.enum(BUDGET_STATES);
export const cyclePhase = z.enum(CYCLE_PHASES);
export const lineDecision = z.enum(LINE_DECISIONS);
export const auditKind = z.enum(AUDIT_KINDS);
export const dataClass = z.enum(DATA_CLASSES);
export const fieldType = z.enum(FIELD_TYPES);
export const granularity = z.enum(GRANULARITIES);
export const driverKey = z.enum(DRIVER_KEYS);
export const ruleSeverity = z.enum(RULE_SEVERITIES);

export const fiscalYear = z.number().int().min(2000).max(2100);
export const period = z.number().int().min(1).max(12);
export const positiveInt = z.number().int().min(1).max(1_000_000);

/**
 * Cost centre and GL codes are matched against a strict pattern rather than
 * being treated as free text — they are used in exports and reconciliation,
 * where a stray separator or leading `=` would be a formula-injection vector.
 */
export const accountCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, 'must be an alphanumeric code');

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export const createLineSchema = z.object({
  entityId: uuid,
  categoryId: uuid,
  name: shortText(200),
  vendor: shortText(200).nullish(),
  costCentreId: uuid.nullish(),
  glAccount: accountCode.nullish(),
  costType,
  currency,
  justification: longText(4000).nullish(),
});

export const updateLineSchema = z.object({
  name: shortText(200).optional(),
  vendor: shortText(200).nullish(),
  costCentreId: uuid.nullish(),
  glAccount: accountCode.nullish(),
  costType: costType.optional(),
  currency: currency.optional(),
  justification: longText(4000).nullish(),
  /** NFR-005 — the version the client believed it was editing. */
  version: z.number().int().min(0),
});

export const setAmountSchema = z.object({
  period,
  amount: moneyString,
  /** FR-014 — the unit the figure was typed in. EUR values are converted back
   *  to the line's local currency before storage. */
  unit: z.enum(['local', 'eur']).default('local'),
  version: z.number().int().min(0),
});

export const bulkOperationSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('uplift'),
    lineIds: z.array(uuid).min(1).max(1000),
    percent: percentString,
  }),
  z.object({
    operation: z.literal('reassign_cost_centre'),
    lineIds: z.array(uuid).min(1).max(1000),
    costCentreId: uuid,
  }),
  z.object({
    operation: z.literal('delete'),
    lineIds: z.array(uuid).min(1).max(1000),
  }),
  z.object({
    operation: z.literal('copy_prior_year'),
    lineIds: z.array(uuid).min(1).max(1000),
  }),
]);

export const linkDriverSchema = z.object({
  driverKey,
  ratePerUnit: rateString,
});

export const recordActualSchema = z.object({
  period,
  amount: moneyString,
  version: z.number().int().min(0),
});

export const submissionDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'request_info']),
  comment: longText(4000),
});

export const lineDecisionSchema = z.object({
  decision: lineDecision,
  comment: longText(2000).optional(),
});

export const costCentreCreateSchema = z.object({
  code: accountCode,
  description: shortText(300),
});

export const fxRateSchema = z.object({
  currency,
  fiscalYear,
  // A zero rate would make every converted figure zero and every reverse
  // conversion a division by zero, so it is rejected at the boundary.
  rate: rateString.refine((v) => /[1-9]/.test(v), {
    message: 'rate must be greater than zero',
  }),
});

export const auditQuerySchema = z.object({
  kind: auditKind.optional(),
  /** FR-072 full-text search. Parameterised at the database layer (SEC-020). */
  q: shortText(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const consumptionFilterSchema = z.object({
  entityId: uuid.optional(),
  categoryId: uuid.optional(),
  managerUserId: uuid.optional(),
});

export const reminderSchema = z.object({
  targetRole: z.string().max(64),
  message: longText(2000),
});

export const retentionSchema = z.object({
  dataset: z.enum(['audit', 'budget', 'free_text', 'inactive_users', 'backups']),
  months: z.number().int().min(1).max(600),
});

export const classificationSchema = z.object({
  fieldKey: z.string().max(128).regex(/^[a-z][a-z0-9_.]{0,127}$/),
  dataClass,
});

/** NFR-010. The set matches the catalogues in packages/web/src/i18n and the
 *  CHECK constraint on `users.locale`; a value here without a catalogue would
 *  render English while claiming otherwise. */
export const localeSchema = z.object({
  locale: z.enum(['en', 'sv', 'nb', 'da', 'fi', 'fr']),
});

// ---------------------------------------------------------------------------
// FR-005 template versioning
// ---------------------------------------------------------------------------

export const templateVersionCreateSchema = z.object({
  /** Optional note describing what changed. Shown in the version list. */
  note: shortText(500).optional(),
});

export const templateFieldSchema = z.object({
  fieldKey: z.string().max(64).regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a lower-case key'),
  label: shortText(120),
  fieldType,
  required: z.boolean(),
  visible: z.boolean(),
  position: z.number().int().min(0).max(999),
});

// ---------------------------------------------------------------------------
// FR-051 configurable approval stages
// ---------------------------------------------------------------------------

/**
 * The role a stage requires is validated against `STAGE_APPROVER_ROLES` in the
 * handler rather than here: the permitted set is derived from the permission
 * matrix, and this module must not import the matrix to stay a pure leaf.
 */
export const approvalStageSchema = z.object({
  name: shortText(120),
  requiredRole: z.string().max(32).regex(/^[a-z][a-z_]{0,31}$/),
  /** A stage applies only to submissions at or above this EUR total. */
  minAmountEur: moneyString,
  enabled: z.boolean(),
});

/** Reorder is a whole-list operation: partial reorders can produce duplicates. */
export const approvalStageOrderSchema = z.object({
  /** Stage ids in their new order. Must be the complete set for the year. */
  stageIds: z.array(uuid).min(1).max(20),
});

export const stageDecisionSchema = z.object({
  stageId: uuid,
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  comment: longText(4000).optional(),
});

// ---------------------------------------------------------------------------
// FR-040 ledger ingestion
// ---------------------------------------------------------------------------

/** The feed's own identifier for a row or a batch. Opaque to us; bounded here. */
export const ledgerRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'must be an alphanumeric reference');

export const ledgerRowSchema = z.object({
  /** Addressed by the line's stable external key, not by our UUID. */
  lineRef: ledgerRef,
  period,
  amount: moneyString,
  /** The ledger's reference for the posting, kept for reconciliation. */
  postingRef: ledgerRef.optional(),
});

export const ledgerBatchSchema = z.object({
  externalRef: ledgerRef,
  fiscalYear,
  sourceSystem: shortText(64),
  // Bounded because the whole batch is validated and applied in one
  // transaction; an unbounded array is a memory and lock-duration problem.
  rows: z.array(ledgerRowSchema).min(1).max(5000),
});

// ---------------------------------------------------------------------------
// FR-080 budget versions and scenarios
// ---------------------------------------------------------------------------

/**
 * A version key. Slug-shaped because it appears in a query string and in the
 * `budget_version` column, and because a key that needed escaping would make
 * every comparison URL a place to get it wrong. The same pattern is asserted by
 * the CHECK constraint in migration 008, so a value that reached the database
 * another way is refused there too.
 */
export const versionKey = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'must be lowercase letters, digits, hyphen or underscore');

export const createVersionSchema = z.object({
  key: versionKey,
  label: shortText(120),
  // `working` is absent on purpose: exactly one exists per year and the cycle
  // creates it. Offering it here would be offering a request that must fail.
  kind: z.enum(['baseline', 'scenario', 'forecast']),
  description: longText(500).nullish(),
  copyFrom: versionKey.nullish(),
});

/**
 * FR-020 driver trees. A driver is either typed in or derived from another;
 * the union makes the two states exclusive rather than leaving a row that
 * carries both a value and a definition and no rule about which wins.
 */
/** Only the caption moves. The key is what every amount references and the
 *  kind is what the migration-008 trigger refuses to change. */
export const renameVersionSchema = z.object({
  label: shortText(120),
  description: longText(500).nullish(),
});

export const driverInputSchema = z.object({
  entityId: uuid,
  driverKey,
  unit: shortText(40),
}).and(
  z.union([
    z.object({
      value: z.number().int().min(0).max(10_000_000),
      derivedFrom: z.null().optional(),
      factor: z.null().optional(),
    }),
    z.object({
      value: z.number().int().min(0).max(10_000_000).optional(),
      derivedFrom: driverKey,
      // Bounded above so a tree cannot be used to produce an absurd headcount,
      // and allowed below one so "sites per store" can be a fraction.
      factor: rateString.refine(
        (v) => Number(v) > 0 && Number(v) <= 1000,
        'factor must be greater than zero and at most 1000',
      ),
    }),
  ]),
);

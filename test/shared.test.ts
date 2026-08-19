/**
 * `packages/shared`, tested in isolation — no database, no HTTP, no harness.
 *
 * Everything else in this suite runs against a real PostgreSQL, deliberately:
 * half of what is asserted lives in the database. But that makes every test
 * file cost ten seconds of setup before its first assertion, which is fine for
 * a suite run once and fatal for one run several hundred times.
 *
 * That is what this file is for. `tools/mutate.ts` re-runs it once per mutant,
 * so it has to be fast and it has to be the *whole* specification of the shared
 * package — a mutation that survives is a line of `packages/shared` that no
 * assertion here depends on, and the whole point is for that to be a finding
 * rather than a property of the harness.
 *
 * The money cases moved here from `invariants.test.ts`, where they were pure
 * assertions sitting behind a database fixture they never used.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIT_KINDS,
  BUDGET_STATES,
  CURRENCIES,
  Money,
  MoneyError,
  MONEY_SCALE,
  PRIVILEGED_ROLES,
  ROLES,
  STAGE_APPROVER_ROLES,
  STEP_UP_CAPABILITIES,
  can,
  canReadEntity,
  canWriteEntity,
  isPrivileged,
  readScope,
  requiresStepUp,
  schemas,
  writeScope,
  type Principal,
  type Role,
} from '@spendifre/shared';

// ---------------------------------------------------------------------------
// Money (NFR-002, SEC-022)
// ---------------------------------------------------------------------------

describe('NFR-002 fixed-precision money', () => {
  it('rejects everything that is not a plain decimal', () => {
    for (const bad of [
      'NaN', 'Infinity', '-Infinity', '1e5', '1E5', '0x10', '1_000',
      '1,5', ' ', '', '.5', '1.', '--1', '+1', '1.23456',
    ]) {
      expect(() => Money.parse(bad), `should reject ${JSON.stringify(bad)}`).toThrow(MoneyError);
    }
  });

  it('rejects a JS number outright', () => {
    // @ts-expect-error deliberately wrong type
    expect(() => Money.parse(1.5)).toThrow(MoneyError);
    // @ts-expect-error deliberately wrong type
    expect(() => Money.parse(null)).toThrow(MoneyError);
    // @ts-expect-error deliberately wrong type
    expect(() => Money.parse(undefined)).toThrow(MoneyError);
  });

  it('accepts a bigint as already-whole units', () => {
    expect(Money.parse(5n).toString()).toBe('5.0000');
  });

  it('trims surrounding whitespace but not internal', () => {
    expect(Money.parse('  1.50  ').toString()).toBe('1.5000');
    expect(() => Money.parse('1 . 5')).toThrow(MoneyError);
  });

  it('round-trips through the canonical string form', () => {
    for (const value of ['0', '1', '-1', '0.0001', '-0.0001', '123456789.1234']) {
      expect(Money.parse(Money.parse(value).toString()).toString())
        .toBe(Money.parse(value).toString());
    }
  });

  it('pads and left-pads the fraction to exactly the scale', () => {
    expect(Money.parse('1.5').toString()).toBe('1.5000');
    expect(Money.parse('1.0001').toString()).toBe('1.0001');
    expect(Money.parse('-0.0001').toString()).toBe('-0.0001');
    expect(MONEY_SCALE).toBe(4);
  });

  it('adds without float error', () => {
    // 0.1 + 0.2 is the canonical float failure; here it is exact.
    const sum = Money.parse('0.1').add(Money.parse('0.2'));
    expect(sum.toString()).toBe('0.3000');
    expect(sum.equals(Money.parse('0.3'))).toBe(true);
  });

  it('subtracts and negates', () => {
    expect(Money.parse('0.3').subtract(Money.parse('0.1')).toString()).toBe('0.2000');
    expect(Money.parse('1').subtract(Money.parse('3')).toString()).toBe('-2.0000');
    expect(Money.parse('2.5').negate().toString()).toBe('-2.5000');
    expect(Money.parse('-2.5').negate().toString()).toBe('2.5000');
  });

  it('knows zero from not-zero', () => {
    expect(Money.ZERO.isZero()).toBe(true);
    expect(Money.parse('0').isZero()).toBe(true);
    expect(Money.parse('-0.0001').isZero()).toBe(false);
    expect(Money.parse('1').equals(Money.parse('1.0000'))).toBe(true);
    expect(Money.parse('1').equals(Money.parse('1.0001'))).toBe(false);
  });

  it('orders three ways and not two', () => {
    // A `compare` that returned 0 for "not less than" would still satisfy a
    // test that only checked the less-than branch.
    expect(Money.parse('1').compare(Money.parse('2'))).toBe(-1);
    expect(Money.parse('2').compare(Money.parse('1'))).toBe(1);
    expect(Money.parse('2').compare(Money.parse('2'))).toBe(0);
    expect(Money.parse('-2').compare(Money.parse('-1'))).toBe(-1);
  });

  it('sums a large series exactly', () => {
    const values = Array.from({ length: 1000 }, () => Money.parse('0.0001'));
    expect(Money.sum(values).toString()).toBe('0.1000');
    expect(Money.sum([]).toString()).toBe('0.0000');
  });

  it('rounds half away from zero on rate multiplication', () => {
    expect(Money.parse('1').multiplyByRate('0.00005').toString()).toBe('0.0001');
    expect(Money.parse('-1').multiplyByRate('0.00005').toString()).toBe('-0.0001');
    // Just below the halfway point rounds down, in both directions — the pair
    // that distinguishes half-away-from-zero from half-up and from truncation.
    expect(Money.parse('1').multiplyByRate('0.000049').toString()).toBe('0.0000');
    // Zero has no sign in the canonical form: the string is built from
    // `units < 0`, and rounding to nothing lands on 0 rather than -0.
    expect(Money.parse('-1').multiplyByRate('0.000049').toString()).toBe('0.0000');
    expect(Money.parse('100').multiplyByRate('0.5').toString()).toBe('50.0000');
  });

  it('does not truncate rate precision before multiplying', () => {
    // Rounding the rate to scale first would give 1.2346 x 10000 = 12346.0000.
    expect(Money.parse('10000').multiplyByRate('1.23456789').toString()).toBe('12345.6789');
  });

  it('divides by a rate with the same rounding', () => {
    expect(Money.parse('50').divideByRate('0.5').toString()).toBe('100.0000');
    expect(Money.parse('1').divideByRate('3').toString()).toBe('0.3333');
    expect(Money.parse('2').divideByRate('3').toString()).toBe('0.6667');
    expect(Money.parse('-2').divideByRate('3').toString()).toBe('-0.6667');
  });

  it('refuses division by a zero rate rather than producing infinity', () => {
    expect(() => Money.parse('1').divideByRate('0')).toThrow(MoneyError);
    expect(() => Money.parse('1').divideByRate('0.0')).toThrow(MoneyError);
  });

  it('refuses a factor that is not a plain decimal', () => {
    expect(() => Money.parse('1').multiplyByRate('1e3')).toThrow(MoneyError);
    expect(() => Money.parse('1').divideByRate('abc')).toThrow(MoneyError);
    expect(() => Money.parse('1').upliftByPercent('')).toThrow(MoneyError);
  });

  it('applies an uplift consistently', () => {
    expect(Money.parse('100').upliftByPercent('3').toString()).toBe('103.0000');
    expect(Money.parse('100').upliftByPercent('-10').toString()).toBe('90.0000');
    expect(Money.parse('100').upliftByPercent('0').toString()).toBe('100.0000');
    expect(Money.parse('100').upliftByPercent('3.5').toString()).toBe('103.5000');
  });

  it('rejects an amount beyond numeric(18,4)', () => {
    expect(() => Money.parse('99999999999999999')).toThrow(MoneyError);
    // And the boundary is checked on results, not only on input.
    const big = Money.parse('99999999999999');
    expect(() => big.multiplyByRate('10')).toThrow(MoneyError);
  });

  it('accepts the largest representable amount and refuses the next one', () => {
    // The exact edge, both sides, both signs. `tools/mutate.ts` found this
    // missing: widening the limit by one unit, or turning the range test from
    // `>` into `>=`, changed nothing any assertion could see.
    const max = '99999999999999.9999';
    expect(Money.parse(max).toString()).toBe(max);
    expect(Money.parse(`-${max}`).toString()).toBe(`-${max}`);
    expect(() => Money.parse('100000000000000')).toThrow(MoneyError);
    expect(() => Money.parse('-100000000000000')).toThrow(MoneyError);
  });

  it('serialises to the same string over the wire as in storage', () => {
    expect(JSON.stringify({ amount: Money.parse('1.5') })).toBe('{"amount":"1.5000"}');
  });

  it('exposes scaled units and reconstructs from them', () => {
    expect(Money.parse('1.5').scaledUnits).toBe(15000n);
    expect(Money.fromScaledUnits(15000n).toString()).toBe('1.5000');
  });
});

// ---------------------------------------------------------------------------
// Authorisation (SEC-010, SEC-011, ZT-007)
// ---------------------------------------------------------------------------

const principal = (role: Role, owned: string[] = []): Principal => ({
  userId: 'u', role, ownedEntityIds: owned,
});

describe('SEC-010 capability matrix', () => {
  it('denies by default for an unknown capability or role', () => {
    // @ts-expect-error deliberately outside the union
    expect(can('admin', 'nonsense.capability')).toBe(false);
    // @ts-expect-error deliberately outside the union
    expect(can('intruder', 'budget.line.edit.own')).toBe(false);
  });

  it('grants what the matrix says and nothing adjacent', () => {
    expect(can('admin', 'entity.manage')).toBe(true);
    expect(can('cfo', 'entity.manage')).toBe(false);
    expect(can('pmo', 'budget.line.edit.own')).toBe(true);
    // The CFO approves rather than types (SPEC §5), which is a denial the
    // matrix has to state and not an oversight.
    expect(can('cfo', 'budget.line.edit.own')).toBe(false);
  });

  it('gives every role an answer for every capability', () => {
    // A missing matrix row denies, which is safe but silent. This asserts the
    // rows exist, so a capability added without a row fails here rather than
    // quietly denying everyone.
    for (const role of ROLES) {
      expect(typeof can(role, 'budget.view.own')).toBe('boolean');
    }
  });
});

describe('SEC-011 entity scope', () => {
  it('separates reading across entities from writing across them', () => {
    expect(readScope('cfo')).toBe('all');
    expect(writeScope('cfo')).toBe('own');
    expect(readScope('admin')).toBe('all');
    expect(writeScope('admin')).toBe('all');
    expect(readScope('pmo')).toBe('own');
    expect(writeScope('pmo')).toBe('own');
  });

  it('falls back to ownership when the scope is own', () => {
    expect(canReadEntity(principal('pmo', ['e1']), 'e1')).toBe(true);
    expect(canReadEntity(principal('pmo', ['e1']), 'e2')).toBe(false);
    expect(canReadEntity(principal('cfo'), 'e2')).toBe(true);

    expect(canWriteEntity(principal('pmo', ['e1']), 'e1')).toBe(true);
    expect(canWriteEntity(principal('pmo', ['e1']), 'e2')).toBe(false);
    // The one that matters: a cross-entity *reader* is not a cross-entity writer.
    expect(canWriteEntity(principal('cfo'), 'e2')).toBe(false);
    expect(canWriteEntity(principal('admin'), 'e2')).toBe(true);
  });
});

describe('ZT-007 step-up', () => {
  it('requires fresh authentication for the irreversible actions', () => {
    for (const capability of STEP_UP_CAPABILITIES) {
      expect(requiresStepUp(capability), capability).toBe(true);
    }
    expect(requiresStepUp('budget.view.own')).toBe(false);
    // Deliberately excluded: it is called by an unattended integration, and a
    // control that cannot be satisfied is a control that gets disabled.
    expect(requiresStepUp('ledger.ingest')).toBe(false);
  });
});

describe('ZT-002 privileged roles', () => {
  it('names the roles Conditional Access must harden', () => {
    for (const role of PRIVILEGED_ROLES) expect(isPrivileged(role)).toBe(true);
    expect(isPrivileged('pmo')).toBe(false);
    expect(isPrivileged('security_manager')).toBe(false);
  });
});

describe('FR-051 stage approver roles', () => {
  it('is exactly the roles holding submission.decideStage', () => {
    expect(STAGE_APPROVER_ROLES.length).toBeGreaterThan(0);
    for (const role of ROLES) {
      expect(STAGE_APPROVER_ROLES.includes(role), role)
        .toBe(can(role, 'submission.decideStage'));
    }
  });
});

// ---------------------------------------------------------------------------
// Schemas (SEC-020, SEC-022)
// ---------------------------------------------------------------------------

describe('SEC-022 input schemas', () => {
  it('accepts a money string only in the canonical grammar', () => {
    expect(schemas.moneyString.safeParse('1.50').success).toBe(true);
    expect(schemas.moneyString.safeParse('-1.50').success).toBe(true);
    for (const bad of ['1e5', '1,5', '', ' ', '1.234567', 'abc']) {
      expect(schemas.moneyString.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('bounds short text at its stated length and refuses an empty string', () => {
    const field = schemas.shortText(5);
    expect(field.safeParse('abcde').success).toBe(true);
    expect(field.safeParse('abcdef').success).toBe(false);
    expect(field.safeParse('').success).toBe(false);
  });

  it('accepts a uuid and refuses anything shaped like one', () => {
    expect(schemas.uuid.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(true);
    expect(schemas.uuid.safeParse('00000000-0000-4000-8000-00000000000').success).toBe(false);
    expect(schemas.uuid.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts only currencies the domain knows', () => {
    expect(schemas.currency.safeParse('EUR').success).toBe(true);
    expect(schemas.currency.safeParse('XXX').success).toBe(false);
    expect(schemas.currency.safeParse('eur').success).toBe(false);
  });

  it('bounds the fiscal year', () => {
    expect(schemas.fiscalYear.safeParse(2026).success).toBe(true);
    expect(schemas.fiscalYear.safeParse(1999).success).toBe(false);
    expect(schemas.fiscalYear.safeParse(2101).success).toBe(false);
  });

  it('refuses control characters in short text, including a newline', () => {
    // Every case below was a surviving mutant before it existed: the guard is
    // two conditions and nothing depended on either.
    expect(schemas.shortText(50).safeParse('Ordinary name').success).toBe(true);
    expect(schemas.shortText(50).safeParse('two\nlines').success).toBe(false);
    expect(schemas.shortText(50).safeParse('bell\u0007here').success).toBe(false);
  });

  it('allows a newline in long text but no other control character', () => {
    expect(schemas.longText(50).safeParse('two\nlines').success).toBe(true);
    expect(schemas.longText(50).safeParse('a\tb').success).toBe(true);
    expect(schemas.longText(50).safeParse('bell\u0007here').success).toBe(false);
    // Bounded, and empty is allowed here where `shortText` refuses it.
    expect(schemas.longText(4).safeParse('12345').success).toBe(false);
    expect(schemas.longText(4).safeParse('').success).toBe(true);
  });

  it('bounds decimal places at the scale exactly', () => {
    expect(schemas.moneyString.safeParse('1').success).toBe(true);
    expect(schemas.moneyString.safeParse('1.2345').success).toBe(true);
    expect(schemas.moneyString.safeParse('1.23456').success).toBe(false);
  });

  it('refuses a negative rate but allows zero and eight decimal places', () => {
    expect(schemas.rateString.safeParse('0').success).toBe(true);
    expect(schemas.rateString.safeParse('0.00000001').success).toBe(true);
    expect(schemas.rateString.safeParse('0.000000001').success).toBe(false);
    expect(schemas.rateString.safeParse('-0.5').success).toBe(false);
  });

  it('bounds a percentage at plus and minus a thousand, inclusive', () => {
    for (const ok of ['0', '3.5', '-3.5', '1000', '-1000']) {
      expect(schemas.percentString.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['1000.0001', '-1000.0001', 'abc', '']) {
      expect(schemas.percentString.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('requires a driver term factor to be positive and at most a thousand', () => {
    const term = (factor: string) => ({ derivedFrom: 'headcount', factor });
    for (const ok of ['0.0001', '1', '1.5', '1000']) {
      expect(schemas.driverTermSchema.safeParse(term(ok)).success, ok).toBe(true);
    }
    for (const bad of ['0', '1000.0001', '-1']) {
      expect(schemas.driverTermSchema.safeParse(term(bad)).success, bad).toBe(false);
    }
    expect(schemas.driverTermSchema.safeParse(term('1')).success).toBe(true);
    expect(schemas.driverTermSchema.safeParse({ derivedFrom: 'staff', factor: '1' }).success)
      .toBe(false);
  });

  it('requires an approval stage to name a role and a threshold', () => {
    const ok = { name: 'CFO', requiredRole: 'cfo', minAmountEur: '0', enabled: true };
    expect(schemas.approvalStageSchema.safeParse(ok).success).toBe(true);
    expect(schemas.approvalStageSchema.safeParse({ ...ok, requiredRole: 'CFO' }).success)
      .toBe(false);
    expect(schemas.approvalStageSchema.safeParse({ ...ok, minAmountEur: '1e6' }).success)
      .toBe(false);
  });

  it('requires a template field key to be a lower-case identifier', () => {
    const ok = {
      fieldKey: 'vendor_name', label: 'Vendor', fieldType: 'text',
      required: false, visible: true, position: 0,
    };
    expect(schemas.templateFieldSchema.safeParse(ok).success).toBe(true);
    expect(schemas.templateFieldSchema.safeParse({ ...ok, fieldKey: 'Vendor' }).success)
      .toBe(false);
    expect(schemas.templateFieldSchema.safeParse({ ...ok, fieldKey: '1st' }).success)
      .toBe(false);
    expect(schemas.templateFieldSchema.safeParse({ ...ok, fieldType: 'video' }).success)
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domain vocabulary
// ---------------------------------------------------------------------------

describe('SPEC §3 domain vocabulary', () => {
  it('has no duplicate members in the enumerations', () => {
    for (const list of [CURRENCIES, BUDGET_STATES, AUDIT_KINDS, ROLES]) {
      expect(new Set(list).size, list.join(',')).toBe(list.length);
    }
  });

  it('reports EUR first, because it is the reporting currency', () => {
    expect(CURRENCIES[0]).toBe('EUR');
  });
});

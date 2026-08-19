/**
 * Fixed-precision money (NFR-002, SEC-022).
 *
 * Amounts are held as a bigint of "minor units" scaled by 10^SCALE. There is no
 * float arithmetic anywhere in this module, and no code path outside it may
 * construct a Money from a JS `number` — the only entry points are string
 * parsers with an allow-list grammar.
 *
 * SCALE 4 matches `numeric(18,4)` in the schema, which is enough headroom for
 * FX-converted values without losing minor units on the way back to local
 * currency (FR-014).
 */

export const MONEY_SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(MONEY_SCALE);

/** Largest magnitude we accept, matching numeric(18,4): 14 integer digits. */
const MAX_UNITS = 10n ** 18n - 1n;

/**
 * Allow-list grammar (SEC-022): optional sign, digits, optional fraction.
 * Deliberately rejects exponent notation (`1e5`), `Infinity`, `NaN`, hex,
 * underscores, whitespace-separated groups and thousands separators. A caller
 * that wants to accept "1 234,50" must normalise it in the locale layer first,
 * where the locale is known.
 */
const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export class Money {
  /** Scaled minor units. Private so the invariant cannot be bypassed. */
  readonly #units: bigint;

  private constructor(units: bigint) {
    if (units > MAX_UNITS || units < -MAX_UNITS) {
      throw new MoneyError('amount out of range');
    }
    this.#units = units;
  }

  static readonly ZERO = new Money(0n);

  /** Parse from a decimal string. The only public constructor for external input. */
  static parse(input: unknown): Money {
    if (typeof input === 'bigint') return new Money(input * SCALE_FACTOR);
    if (typeof input !== 'string') {
      throw new MoneyError('amount must be a decimal string');
    }
    const trimmed = input.trim();
    if (!DECIMAL_RE.test(trimmed)) {
      throw new MoneyError('amount is not a plain decimal');
    }
    const negative = trimmed.startsWith('-');
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [whole = '0', fraction = ''] = unsigned.split('.');
    if (fraction.length > MONEY_SCALE) {
      throw new MoneyError(`amount has more than ${MONEY_SCALE} decimal places`);
    }
    const padded = fraction.padEnd(MONEY_SCALE, '0');
    const units = BigInt(whole) * SCALE_FACTOR + BigInt(padded);
    return new Money(negative ? -units : units);
  }

  /**
   * Trusted constructor for values already stored at full scale (e.g. read back
   * from `numeric(18,4)`). Not for request input.
   */
  static fromScaledUnits(units: bigint): Money {
    return new Money(units);
  }

  get scaledUnits(): bigint {
    return this.#units;
  }

  add(other: Money): Money {
    return new Money(this.#units + other.#units);
  }

  subtract(other: Money): Money {
    return new Money(this.#units - other.#units);
  }

  negate(): Money {
    return new Money(-this.#units);
  }

  isZero(): boolean {
    return this.#units === 0n;
  }

  equals(other: Money): boolean {
    return this.#units === other.#units;
  }

  compare(other: Money): -1 | 0 | 1 {
    if (this.#units < other.#units) return -1;
    if (this.#units > other.#units) return 1;
    return 0;
  }

  static sum(values: readonly Money[]): Money {
    let total = 0n;
    for (const v of values) total += v.scaledUnits;
    return new Money(total);
  }

  /**
   * Multiply by a decimal-string factor (an FX rate or a driver rate), rounding
   * half-away-from-zero at MONEY_SCALE. Rate precision is not truncated before
   * the multiply, so the rounding happens exactly once, at the end.
   */
  multiplyByRate(rate: string): Money {
    const { units: rateUnits, scale: rateScale } = parseDecimalToUnits(rate);
    const product = this.#units * rateUnits;
    const divisor = 10n ** BigInt(rateScale);
    return new Money(divideRoundHalfAway(product, divisor));
  }

  /**
   * Divide by a decimal-string factor, same rounding. Used to convert a value
   * typed in EUR back to the line's local currency before storage (FR-014).
   */
  divideByRate(rate: string): Money {
    const { units: rateUnits, scale: rateScale } = parseDecimalToUnits(rate);
    if (rateUnits === 0n) throw new MoneyError('cannot divide by a zero rate');
    const scaled = this.#units * 10n ** BigInt(rateScale);
    return new Money(divideRoundHalfAway(scaled, rateUnits));
  }

  /** Apply a percentage uplift, e.g. "3.5" for +3.5% (FR-015). */
  upliftByPercent(percent: string): Money {
    const { units: pctUnits, scale: pctScale } = parseDecimalToUnits(percent);
    const divisor = 100n * 10n ** BigInt(pctScale);
    const delta = divideRoundHalfAway(this.#units * pctUnits, divisor);
    return new Money(this.#units + delta);
  }

  /** Canonical decimal string. This is the wire and storage format. */
  toString(): string {
    const negative = this.#units < 0n;
    const abs = negative ? -this.#units : this.#units;
    const whole = abs / SCALE_FACTOR;
    const fraction = (abs % SCALE_FACTOR).toString().padStart(MONEY_SCALE, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

function parseDecimalToUnits(input: string): { units: bigint; scale: number } {
  const trimmed = input.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new MoneyError('factor is not a plain decimal');
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

/**
 * Integer division rounding half away from zero — the convention finance
 * expects, and the one that keeps `sum(children)` stable under restatement.
 */
function divideRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  // The three `< 0n` tests below cannot be widened to `<= 0n` observably: at
  // zero the only difference is the sign of a zero, and -0n is 0n. Marked so
  // the survivor list stays a list of real gaps.
  // mutate-ignore: < -> <= — at zero the sign flips onto a zero result
  const negative = numerator < 0n !== denominator < 0n;
  // mutate-ignore: < -> <= — negating zero yields zero
  const absN = numerator < 0n ? -numerator : numerator;
  // mutate-ignore: < -> <= — negating zero yields zero, and a zero divisor is refused above
  const absD = denominator < 0n ? -denominator : denominator;
  const quotient = absN / absD;
  const remainder = absN % absD;
  const rounded = remainder * 2n >= absD ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

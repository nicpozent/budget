# ADR 0002 — Money as scaled bigint, never float

**Status:** Accepted · **Drivers:** `NFR-002`, `SEC-022`

## Decision

Money is a `Money` value object wrapping a `bigint` of minor units scaled by
10^4, matching `numeric(18,4)` in the schema. Amounts cross the wire as
canonical decimal *strings*. `pg`'s parser for `numeric` is overridden so values
arrive as strings and are never coerced to a JS number.

Rates are **not** money. FX rates carry up to 8 decimal places
(`numeric(18,8)`), because VND (0.0000363), LAK and KRW round to nothing at 4.

## Why

A JS `number` cannot represent 0.1 + 0.2 exactly. In a consolidation folding
~500 lines across 21 entities and five years, that error compounds and
`INV-4` — parent equals the sum of children — stops holding. Making the only
public constructor a string parser means no call site can accidentally
introduce a float.

The parser is an allow-list: it rejects `NaN`, `Infinity`, exponent notation,
hex, thousands separators and excess precision. Exponent notation matters
specifically because `Number('1e5')` succeeds silently.

## Consequences

- Slightly more ceremony: `Money.parse('100')` rather than `100`.
- Rounding is stated once, half-away-from-zero, and applied at a single point
  in each operation, so a value multiplied then divided does not drift twice.
- A local → EUR → local display round trip can differ by one minor unit scaled
  by 1/rate. Storage is unaffected: amounts are always held in the line's own
  currency and an EUR-typed figure is converted exactly once, on the way in.

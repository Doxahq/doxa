/**
 * Exact USD amounts for the meter. The meter adds model costs exactly and
 * rounds once, at settle (spec 10.5). Amounts are bigint picodollars
 * (1e-12 USD), the precision of `credit_reservations.consumed_cost_usd`
 * (numeric with 12 decimals).
 */
export type PicoUsd = bigint;

export const PICO_PER_USD = 1_000_000_000_000n;
const SCALE_DIGITS = 12;

/**
 * Parses a cost such as `0.00001`, `1e-7` or the number `0.72`. Digits past
 * 12 decimals round up, so the meter never undercharges. Returns null for
 * null, a negative value or a value that is not a finite number.
 */
export function parseUsd(value: number | string | null | undefined): PicoUsd | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? (Number.isFinite(value) ? numberToPlainString(value) : null) : value.trim();
  if (text === null) return null;
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return null;
  const intPart = match[1] ?? "";
  const fracPart = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  // digits * 10^(exponent - fracPart.length) USD, in picodollars.
  const digits = BigInt(`${intPart}${fracPart}` || "0");
  const shift = exponent - fracPart.length + SCALE_DIGITS;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return ceilDiv(digits, divisor);
}

function numberToPlainString(value: number): string {
  // `String(1e-7)` is "1e-7", which the parser accepts. Negative numbers fail the regex.
  return String(value);
}

/** Picodollars as a decimal string with 12 decimals, for a numeric column. */
export function formatUsd12(value: PicoUsd): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / PICO_PER_USD;
  const frac = (abs % PICO_PER_USD).toString().padStart(SCALE_DIGITS, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Picodollars as a JS number of USD, for logs and metrics only. */
export function usdNumber(value: PicoUsd): number {
  return Number(value) / 1e12;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator <= 0n) return -((-numerator) / denominator);
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Monthly allowance windows (spec 10.3). One window is one month from the
 * subscription's billing anchor, also for yearly prices. A month without the
 * anchor day ends on its last day, as Stripe does: anchor 31 January, next
 * windows start 28 or 29 February, then 31 March. All math is in UTC.
 */

export interface AllowanceWindow {
  readonly start: Date;
  /** Exclusive. The allowance grant expires here. */
  readonly end: Date;
  /** Months since the anchor (0 = the window that starts at the anchor). */
  readonly index: number;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The anchor moved by `months`, with the day clamped to the month's last day. The anchor's day, not the previous result, sets the day. */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()),
  );
}

/** The window that contains `now`. Before the anchor, windows count backwards. */
export function allowanceWindow(anchor: Date, now: Date): AllowanceWindow {
  let index = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (addMonthsClamped(anchor, index) > now) index -= 1;
  while (addMonthsClamped(anchor, index + 1) <= now) index += 1;
  return { start: addMonthsClamped(anchor, index), end: addMonthsClamped(anchor, index + 1), index };
}

/** The idempotency key of the allowance grant of one window. */
export function allowanceSourceRef(accountId: string, windowStart: Date): string {
  return `allowance:${accountId}:${windowStart.toISOString()}`;
}

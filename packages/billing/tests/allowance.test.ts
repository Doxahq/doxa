import { describe, expect, it } from "vitest";

import { addMonthsClamped, allowanceSourceRef, allowanceWindow } from "../src/credits/allowance";

const d = (iso: string) => new Date(iso);
const day = (date: Date) => date.toISOString().slice(0, 10);

describe("allowance windows", () => {
  it.each([
    ["2026-01-01T00:00:00Z", ["2026-02-01", "2026-03-01", "2026-04-01"]],
    ["2026-01-15T09:30:00Z", ["2026-02-15", "2026-03-15", "2026-04-15"]],
    ["2026-01-28T00:00:00Z", ["2026-02-28", "2026-03-28", "2026-04-28"]],
    ["2026-01-29T00:00:00Z", ["2026-02-28", "2026-03-29", "2026-04-29"]],
    ["2026-01-30T00:00:00Z", ["2026-02-28", "2026-03-30", "2026-04-30"]],
    ["2026-01-31T00:00:00Z", ["2026-02-28", "2026-03-31", "2026-04-30"]],
  ])("anchor %s gives the next window starts %j", (anchor, starts) => {
    expect([1, 2, 3].map((months) => day(addMonthsClamped(d(anchor), months)))).toEqual(starts);
  });

  it("uses 29 February in a leap year", () => {
    expect(day(addMonthsClamped(d("2028-01-31T00:00:00Z"), 1))).toBe("2028-02-29");
    expect(day(addMonthsClamped(d("2028-01-31T00:00:00Z"), 2))).toBe("2028-03-31");
  });

  it("keeps the time of day of the anchor", () => {
    expect(addMonthsClamped(d("2026-01-31T17:45:12.345Z"), 1).toISOString()).toBe("2026-02-28T17:45:12.345Z");
  });

  it("finds the window that contains now, with an exclusive end", () => {
    const anchor = d("2026-01-31T00:00:00Z");
    const inFeb = allowanceWindow(anchor, d("2026-03-10T00:00:00Z"));
    expect([inFeb.start.toISOString(), inFeb.end.toISOString(), inFeb.index]).toEqual(["2026-02-28T00:00:00.000Z", "2026-03-31T00:00:00.000Z", 1]);
    const atEdge = allowanceWindow(anchor, d("2026-03-31T00:00:00Z"));
    expect(atEdge.start.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    const justBefore = allowanceWindow(anchor, d("2026-03-30T23:59:59.999Z"));
    expect(justBefore.index).toBe(1);
  });

  it("gives a yearly anchor monthly windows (5,000 each month, not 60,000 at once)", () => {
    const yearlyAnchor = d("2026-11-13T12:00:00Z");
    const windows = [0, 1, 11, 12].map((months) => allowanceWindow(yearlyAnchor, addMonthsClamped(yearlyAnchor, months)));
    expect(windows.map((window) => window.index)).toEqual([0, 1, 11, 12]);
    expect(day(windows[3]!.start)).toBe("2027-11-13");
  });

  it("starts a new first window at the new anchor after a monthly to yearly switch", () => {
    const switchAt = d("2026-12-20T08:00:00Z");
    const window = allowanceWindow(switchAt, switchAt);
    expect(window.start.toISOString()).toBe(switchAt.toISOString());
    expect(day(window.end)).toBe("2027-01-20");
  });

  it("starts at the trial end when the trial converts", () => {
    const trialEnd = d("2026-11-20T12:00:00Z");
    expect(allowanceWindow(trialEnd, d("2026-11-20T12:00:00Z")).index).toBe(0);
    expect(allowanceWindow(trialEnd, d("2026-11-20T11:59:59Z")).index).toBe(-1);
  });

  it("keys the grant by account and window start", () => {
    expect(allowanceSourceRef("acct_1", d("2026-02-28T00:00:00Z"))).toBe("allowance:acct_1:2026-02-28T00:00:00.000Z");
  });
});

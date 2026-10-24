import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { shouldSubmitRepair } from "../src/prerender-cache-entrypoint";

describe("repair submission throttle", () => {
  test("submits once for one render inside the cooldown window", () => {
    const cooldowns = new Map<string, number>();
    const renderId = "a".repeat(64);

    expect(shouldSubmitRepair(renderId, 1_000, cooldowns)).toBe(true);
    expect(shouldSubmitRepair(renderId, 1_100, cooldowns)).toBe(false);
    expect(shouldSubmitRepair(renderId, 60_999, cooldowns)).toBe(false);
    expect(shouldSubmitRepair(renderId, 61_001, cooldowns)).toBe(true);
  });

  test("keeps separate cooldowns for separate renders", () => {
    const cooldowns = new Map<string, number>();

    expect(shouldSubmitRepair("a".repeat(64), 0, cooldowns)).toBe(true);
    expect(shouldSubmitRepair("b".repeat(64), 0, cooldowns)).toBe(true);
    expect(shouldSubmitRepair("a".repeat(64), 0, cooldowns)).toBe(false);
  });

  test("bounds the map so one isolate cannot grow without a limit", () => {
    const cooldowns = new Map<string, number>();
    for (let index = 0; index < 900; index += 1) {
      shouldSubmitRepair(`${index}`.padStart(64, "0"), index, cooldowns);
    }

    expect(cooldowns.size).toBeLessThanOrEqual(500);
    // The newest render keeps its cooldown.
    expect(shouldSubmitRepair("899".padStart(64, "0"), 900, cooldowns)).toBe(
      false,
    );
  });
});

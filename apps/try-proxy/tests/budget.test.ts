import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

import { TryBudget } from "../src/budget";

function makeBudget() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => void values.set(key, value),
  };
  return new TryBudget({ storage } as never, {} as never);
}

/** SECURITY REGRESSION GUARDRAIL: the only limit that holds across all locations. */
describe("TryBudget", () => {
  test("allows sends up to the limit, then refuses", async () => {
    const budget = makeBudget();
    expect(await budget.take(2, "2026-11-03")).toBe(true);
    expect(await budget.take(2, "2026-11-03")).toBe(true);
    expect(await budget.take(2, "2026-11-03")).toBe(false);
    expect(await budget.take(2, "2026-11-03")).toBe(false);
  });

  test("starts again on a new UTC day", async () => {
    const budget = makeBudget();
    expect(await budget.take(1, "2026-11-03")).toBe(true);
    expect(await budget.take(1, "2026-11-03")).toBe(false);
    expect(await budget.take(1, "2026-11-04")).toBe(true);
  });
});

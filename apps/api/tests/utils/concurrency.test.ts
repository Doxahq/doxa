import { describe, expect, test } from "vitest";
import { mapWithConcurrency } from "../../src/utils/concurrency";

describe("mapWithConcurrency", () => {
  test("keeps input order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, index) => index);

    const results = await mapWithConcurrency(items, 4, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (item % 3) * 2));
      active -= 1;
      return item * 10;
    });

    expect(results).toEqual(items.map((item) => item * 10));
    expect(peak).toBe(4);
  });

  test("returns an empty array for no items", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

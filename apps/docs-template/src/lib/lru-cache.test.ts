import { describe, expect, it } from "vitest";

import { createLruCache } from "./lru-cache";

describe("createLruCache", () => {
  it("drops the least recently used entry above the limit", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("never holds more than its limit", () => {
    const cache = createLruCache<number, number>(16);
    for (let index = 0; index < 1_000; index += 1) cache.set(index, index);
    expect(cache.size).toBe(16);
  });

  it("rejects a limit below one", () => {
    expect(() => createLruCache(0)).toThrow(RangeError);
  });
});

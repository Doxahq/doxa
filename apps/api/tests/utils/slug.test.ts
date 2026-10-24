import { describe, expect, test } from "vitest";
import { ensureSlug, slugify } from "../../src/utils/slug";

describe("slugify", () => {
  test.each([
    ["Doxa Demo", "doxa-demo"],
    ["  Doxa___Docs!!!  ", "doxa-docs"],
    ["Already-slugged", "already-slugged"],
    ["---", ""],
  ])("normalizes %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  test("caps generated slugs at 80 characters", () => {
    expect(slugify("a".repeat(120))).toHaveLength(80);
  });
});

describe("ensureSlug", () => {
  test("uses the primary value when it produces a slug", () => {
    expect(ensureSlug("Doxa Demo", "fallback")).toBe("doxa-demo");
  });

  test("falls back to fallback text and then project", () => {
    expect(ensureSlug("!!!", "Fallback Project")).toBe("fallback-project");
    expect(ensureSlug("!!!", "???")).toBe("project");
  });
});

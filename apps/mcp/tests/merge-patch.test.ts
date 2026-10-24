import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../src/tools/site/merge-patch";

// RFC 7396, Appendix A: original, patch, result.
const RFC_7396_EXAMPLES: Array<[unknown, unknown, unknown]> = [
  [{ a: "b" }, { a: "c" }, { a: "c" }],
  [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
  [{ a: "b" }, { a: null }, {}],
  [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
  [{ a: ["b"] }, { a: "c" }, { a: "c" }],
  [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
  [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
  [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
  [["a", "b"], ["c", "d"], ["c", "d"]],
  [{ a: "b" }, ["c"], ["c"]],
  [{ a: "foo" }, null, null],
  [{ a: "foo" }, "bar", "bar"],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }],
  [[1, 2], { a: "b", c: null }, { a: "b" }],
  [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];

describe("applyMergePatch", () => {
  it.each(RFC_7396_EXAMPLES)(
    "patches %j with %j",
    (original, patch, result) => {
      expect(applyMergePatch(original, patch)).toEqual(result);
    },
  );

  it("changes neither argument", () => {
    const original = { a: { b: "c" } };
    const patch = { a: { b: null, d: "e" } };
    applyMergePatch(original, patch);
    expect(original).toEqual({ a: { b: "c" } });
    expect(patch).toEqual({ a: { b: null, d: "e" } });
  });

  it("keeps a __proto__ key as data", () => {
    const patch: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = applyMergePatch({}, patch);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result ?? {})).toEqual(["__proto__"]);
    expect({}).not.toHaveProperty("polluted");
  });
});

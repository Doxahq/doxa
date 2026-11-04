import { describe, expect, test } from "vitest";
import { compilePathGlob } from "../src/utils/path-glob";

describe("path globs", () => {
  test("match inside one segment, across segments, and from a brace list", () => {
    const routes = compilePathGlob("apps/*/src/**/*.{routes,handlers}.ts");

    expect(routes("apps/api/src/routes/flags.routes.ts")).toBe(true);
    expect(routes("apps/api/src/flags.handlers.ts")).toBe(true);
    expect(routes("apps/api/v2/src/flags.routes.ts")).toBe(false);
    expect(routes("apps/api/src/flags.ts")).toBe(false);
  });

  test("ignore a leading slash and backslashes in the glob", () => {
    expect(compilePathGlob("/internal\\**")("internal/cache.ts")).toBe(true);
  });

  test("reject a glob whose brace lists name too many patterns", () => {
    expect(() => compilePathGlob("{a,b}".repeat(40))).toThrow(/more than 256 alternatives/);
    expect(() => compilePathGlob("{a,b}".repeat(8))).not.toThrow();
  });
});

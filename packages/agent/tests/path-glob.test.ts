import { describe, expect, test, vi } from "vitest";
import { excludedPathMatcher } from "../src/doxa-agent/reference-instructions";
import { compilePathGlob, normalizePath } from "../src/utils/path-glob";

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

describe("paths that a model writes", () => {
  test("match the same glob with or without a leading ./", () => {
    const internal = compilePathGlob("internal/**");

    expect(internal(normalizePath("./internal/a.ts"))).toBe(true);
    expect(normalizePath(".//internal/a.ts")).toBe("internal/a.ts");
    expect(normalizePath("/internal/a.ts")).toBe("internal/a.ts");
  });

  test("keep a dot folder name intact", () => {
    expect(normalizePath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
  });
});

describe("excluded path matcher", () => {
  test("skips a glob that cannot compile and keeps the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isExcluded = excludedPathMatcher(["{a,b}".repeat(40), "internal/**"]);

    expect(isExcluded?.("internal/cache.ts")).toBe(true);
    expect(isExcluded?.("src/a.ts")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped"));
    warn.mockRestore();
  });

  test("matches a model-written ./ path", () => {
    expect(excludedPathMatcher(["internal/**"])?.("./internal/a.ts")).toBe(true);
  });

  test("gives no matcher when no glob compiles", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(excludedPathMatcher(["{a,b}".repeat(40)])).toBeUndefined();
    warn.mockRestore();
  });
});

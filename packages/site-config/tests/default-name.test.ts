import { describe, expect, test } from "vitest";
import {
  createDefaultSiteConfig,
  parseSiteConfigStrict,
  resolveSiteConfig,
  upgradeV1SiteConfig,
} from "../src";

describe("derived default site names", () => {
  test.each([79, 80, 81, 120])(
    "bounds a %i-character project name",
    (length) => {
      const project = { projectName: "x".repeat(length) };
      const name = "x".repeat(Math.min(length, 80));
      expect(createDefaultSiteConfig(project)).toEqual({ name });
      expect(upgradeV1SiteConfig(project).name).toBe(name);
      expect(project.projectName).toHaveLength(length);
    },
  );

  test("removes unsupported controls before trimming", () => {
    expect(
      createDefaultSiteConfig({ projectName: " \u0000My\n Docs\u007f\u009f " }),
    ).toEqual({ name: "My Docs" });
  });

  test("keeps Unicode code points intact at the limit", () => {
    expect(
      createDefaultSiteConfig({ projectName: "a".repeat(79) + "😀" }).name,
    ).toBe("a".repeat(79));
    expect(
      createDefaultSiteConfig({ projectName: "a".repeat(78) + "😀" }).name,
    ).toBe("a".repeat(78) + "😀");
  });

  test("uses the schema fallback when no display text remains", () => {
    expect(createDefaultSiteConfig({ projectName: "\n \u009f" }).name).toBe(
      resolveSiteConfig({}).name,
    );
  });

  test.each([
    ["x".repeat(81), "too_long"],
    ["Name\n", "invalid_text"],
  ])("does not relax strict validation for edited names: %s", (name, code) => {
    const result = parseSiteConfigStrict({ name });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid edited name");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "/name", code }),
    );
  });

  test("derived names remain valid and idempotent over varied project text", () => {
    const alphabet = ["a", "é", "中", "😀", " ", "\n", "\u009f"];
    for (let seed = 0; seed < 150; seed++) {
      const projectName = Array.from(
        { length: seed },
        (_, index) => alphabet[(seed + index * 3) % alphabet.length],
      ).join("");
      const config = resolveSiteConfig(
        createDefaultSiteConfig({ projectName }),
      );
      expect(parseSiteConfigStrict(config).ok).toBe(true);
      expect(createDefaultSiteConfig({ projectName: config.name }).name).toBe(
        config.name,
      );
    }
  });
});

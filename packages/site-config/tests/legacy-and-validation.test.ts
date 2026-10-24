import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  upgradeV1SiteConfig,
  resolveSiteConfig,
  enforceEntitlements,
  FREE_PLAN_ENTITLEMENTS,
  validationIssueCodeSchema,
  formatIssueMessage,
  toValidationIssues,
  siteConfigSchema,
  siteConfigJsonSchema,
  themeJsonSchema,
  validateSiteConfigLinks,
} from "../src";

describe("legacy feature upgrade", () => {
  it.each([
    [undefined, true, false],
    [{ apiPlayground: false }, false, false],
    [
      resolveSiteConfig({ features: { ai: { chat: true } } }).features,
      true,
      true,
    ],
    [{ apiPlayground: "invalid", ai: { chat: true } }, true, false],
  ])(
    "upgrades missing, partial, full, or invalid features: %j",
    (features, playground, chat) => {
      const config = resolveSiteConfig(
        upgradeV1SiteConfig({ projectName: "Name", features }),
      );
      expect(config.name).toBe("Name");
      expect(config.features.apiPlayground).toBe(playground);
      expect(config.features.ai.chat).toBe(chat);
    },
  );
});

describe("entitlements", () => {
  it("forces branding on the free plan without mutating input", () => {
    const input = { branding: { poweredBy: false } };
    expect(
      enforceEntitlements(input, FREE_PLAN_ENTITLEMENTS).branding?.poweredBy,
    ).toBe(true);
    expect(input.branding.poweredBy).toBe(false);
    expect(
      enforceEntitlements(input, { removePoweredBy: true, maxBranchesPerSite: 10 }).branding?.poweredBy,
    ).toBe(false);
    expect(
      enforceEntitlements({}, FREE_PLAN_ENTITLEMENTS).branding?.poweredBy,
    ).toBe(true);
  });
});

describe("issue model and schema output", () => {
  it.each(validationIssueCodeSchema.options)(
    "has a bounded message for %s",
    (code) => {
      const message = formatIssueMessage(code, { max: 40 });
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(300);
    },
  );
  it("maps every Zod issue kind produced by the config without raw messages", () => {
    const input = {
      name: 5,
      description: "a".repeat(301),
      extra: true,
      version: 2,
      theme: { primary: "evil" },
    };
    const result = siteConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(new Set(result.error.issues.map((issue) => issue.code))).toEqual(
      new Set([
        "invalid_type",
        "too_big",
        "unrecognized_keys",
        "invalid_value",
        "custom",
      ]),
    );
    for (const issue of toValidationIssues(result.error, input)) {
      expect(issue.message).toBe(formatIssueMessage(issue.code, issue.params));
    }
  });
  it("uses invalid_type for an unmapped Zod issue", () => {
    const result = z.string().min(10).safeParse("x");
    if (result.success) throw new Error("Expected an invalid input");
    expect(toValidationIssues(result.error)[0].code).toBe("invalid_type");
  });
  it("emits stable JSON Schemas", () => {
    expect(siteConfigJsonSchema()).toMatchSnapshot();
    expect(themeJsonSchema()).toMatchSnapshot();
  });
  it("reports duplicate and missing link targets as warnings", () => {
    const config = resolveSiteConfig({
      navbar: {
        links: [
          { label: "First", href: "/missing" },
          { label: "Second", href: "/missing" },
        ],
      },
    });
    const issues = validateSiteConfigLinks(config, ["/overview"]);
    expect(issues.map((issue) => issue.code)).toEqual([
      "link_target_not_found",
      "duplicate_link",
      "link_target_not_found",
    ]);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });
});

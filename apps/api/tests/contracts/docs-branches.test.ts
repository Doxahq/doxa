import { describe, expect, it } from "vitest";
import {
  branchNameSchema,
  branchPathSchema,
  classifyBranchPath,
  docsBranchStatusSchema,
  docsConflictSchema,
  docsPublicationSummarySchema,
  publishDocsBranchInputSchema,
  validateBranchName,
} from "@doxahq/contracts/docs-branches";
import { validationIssueCodeSchema } from "@doxahq/contracts/validation";
import { formatIssueMessage } from "@doxahq/contracts/validation-messages";
import { FREE_PLAN_ENTITLEMENTS } from "@doxahq/contracts/entitlements";

describe("branch paths", () => {
  it.each([
    ["source/index.mdx", "page"],
    ["source/guide/index.mdx", "page"],
    ["source/api/getting-started/index.mdx", "page"],
    ["manifest.json", "structure"],
    ["settings/sections.json", "structure"],
    ["settings/documents.json", "structure"],
    ["settings/documents.api-reference.json", "structure"],
    ["settings/site.json", "site_settings"],
    ["assets/rate-limits-diagram.png", "asset"],
    ["assets/flow.svg", "asset"],
  ] as const)("accepts %s as %s", (path, kind) => {
    expect(branchPathSchema.safeParse(path).success).toBe(true);
    expect(classifyBranchPath(path)).toBe(kind);
  });

  it.each([
    "../manifest.json",
    "source/../manifest.json",
    "source/Foo/index.mdx",
    "source/a//index.mdx",
    "source/a/./index.mdx",
    "source/%2e%2e/index.mdx",
    "source/a\\b/index.mdx",
    "/source/index.mdx",
    "search/index.json",
    "settings/other.json",
    "settings/documents.Bad.json",
    "settings/documents.a--b.json",
    "assets/../manifest.json",
    "assets/Diagram.png",
    "assets/diagram.exe",
    "assets/sub/diagram.png",
    "assets/a--b.png",
  ])("rejects %s", (path) => {
    expect(branchPathSchema.safeParse(path).success).toBe(false);
    expect(() => classifyBranchPath(path)).toThrow("Invalid branch path");
  });
});

describe("branch names", () => {
  it.each(["a", "1", "a-b", "a".repeat(40), "a1-b2"])("accepts %s", (name) => {
    expect(branchNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    "",
    "a".repeat(41),
    "-a",
    "a-",
    "a--b",
    "Upper",
    "a_b",
    "a.b",
    "main",
    "head",
    "hidden",
    "preview",
    "draft",
  ])("rejects %s", (name) => {
    expect(branchNameSchema.safeParse(name).success).toBe(false);
  });

  it("returns stable issue codes for invalid and reserved names", () => {
    expect(validateBranchName("a--b")[0]?.code).toBe("invalid_branch_name");
    expect(validateBranchName("main")[0]?.code).toBe("reserved_branch_name");
    expect(validateBranchName("valid-name")).toEqual([]);
  });
});

it("keeps branch publish choices explicit", () => {
  const version = "00000000-0000-4000-8000-000000000001";
  expect(
    publishDocsBranchInputSchema.safeParse({ expectedBaseVersionId: version })
      .success,
  ).toBe(false);
  expect(
    publishDocsBranchInputSchema.safeParse({
      expectedBaseVersionId: version,
      eraseBranch: false,
    }).success,
  ).toBe(false);
  expect(
    publishDocsBranchInputSchema.safeParse({
      expectedBaseVersionId: version,
      expectedRevision: 3,
      eraseBranch: false,
    }).success,
  ).toBe(true);
});

it("does not accept a named branch status without an ID", () => {
  const version = "00000000-0000-4000-8000-000000000001";
  const status = {
    branch: { id: null, kind: "named", name: "feature", revision: 0 },
    baseVersionId: version,
    main: {
      versionId: version,
      versionNumber: 1,
      latestPublication: {
        kind: "import",
        actorName: null,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
    },
    behind: false,
    publicationsSinceBase: 0,
    changeCount: 0,
    preview: null,
  };
  expect(docsBranchStatusSchema.safeParse(status).success).toBe(false);
  expect(
    docsBranchStatusSchema.safeParse({
      ...status,
      branch: { ...status.branch, id: version },
    }).success,
  ).toBe(true);
});

it("requires a page conflict key for a page conflict", () => {
  const conflict = {
    unit: "page",
    key: "structure",
    href: "/a",
    title: "A",
    mine: "modified",
    main: "deleted",
  };
  expect(docsConflictSchema.safeParse(conflict).success).toBe(false);
  expect(
    docsConflictSchema.safeParse({ ...conflict, key: "page:/a" }).success,
  ).toBe(true);
});

it("rejects unknown publication summary fields and excessive titles", () => {
  expect(docsPublicationSummarySchema.safeParse({ extra: true }).success).toBe(
    false,
  );
  expect(
    docsPublicationSummarySchema.safeParse({ pageTitles: Array(21).fill("A") })
      .success,
  ).toBe(false);
});

it("has a message for every issue code and a ten-branch free limit", () => {
  expect(FREE_PLAN_ENTITLEMENTS.maxBranchesPerSite).toBe(10);
  for (const code of validationIssueCodeSchema.options) {
    expect(formatIssueMessage(code, { max: 10 }).length).toBeGreaterThan(0);
  }
});

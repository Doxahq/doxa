import { describe, expect, it } from "vitest";
import {
  BRANCH_ID,
  OTHER_AGENT_BRANCH_ID,
  OWNER,
  PROJECT_A,
  TEAMMATE_AGENT_BRANCH_ID,
  USER_BRANCH_ID,
} from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

const VALID = "---\ntitle: Install\n---\n\n## Steps\n\nRun it.\n";
const BROKEN = "---\ntitle: Install\n---\n\n<Note>\nUnclosed.\n";

async function run(name: string, args: Record<string, unknown>) {
  const harness = createHarness();
  const client = await harness.connect("modern");
  const outcome = await callTool(client, name, {
    projectId: PROJECT_A,
    branch: BRANCH_ID,
    ...args,
  });
  return { harness, outcome };
}

function setContent(content: string, href = "/install") {
  return { type: "set_page_content", href, content };
}

describe("write_page", () => {
  it("writes one set_page_content edit with the mcp origin as the owner", async () => {
    const { harness } = await run("write_page", {
      href: "/install",
      content: VALID,
    });
    expect(harness.written).toEqual([
      {
        actor: { userId: OWNER, origin: "mcp" },
        projectId: PROJECT_A,
        branch: BRANCH_ID,
        edits: [setContent(VALID)],
      },
    ]);
  });

  it("returns mdx_invalid with a positioned issue and writes nothing", async () => {
    const { harness, outcome } = await run("write_page", {
      href: "/install",
      content: BROKEN,
    });
    const error = toolError(outcome);
    expect(error.code).toBe("mdx_invalid");
    expect(outcome.structured).toMatchObject({
      error: { issues: [{ code: "mdx_invalid", path: "/content" }] },
    });
    expect(harness.calls).toEqual([]);
    expect(harness.written).toEqual([]);
  });

  it("maps a stale expectedRevision to conflict with the current revision", async () => {
    const { harness, outcome } = await run("write_page", {
      href: "/install",
      content: VALID,
      expectedRevision: 1,
    });
    const error = toolError(outcome);
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ currentRevision: 2 });
    expect(harness.written).toEqual([]);
  });

  it("writes when expectedRevision matches", async () => {
    const { harness, outcome } = await run("write_page", {
      href: "/install",
      content: VALID,
      expectedRevision: 2,
    });
    expect(outcome.isError).toBe(false);
    expect(harness.written).toHaveLength(1);
  });
});

describe("edit_docs", () => {
  it("checks every page source and names the failing edit", async () => {
    const { harness, outcome } = await run("edit_docs", {
      edits: [setContent(VALID, "/"), setContent(BROKEN)],
    });
    expect(toolError(outcome).code).toBe("mdx_invalid");
    expect(outcome.structured).toMatchObject({
      error: { issues: [{ path: "/edits/1/content" }] },
    });
    expect(harness.written).toEqual([]);
  });

  it("a dry run reports MDX issues and calls no service", async () => {
    const { harness, outcome } = await run("edit_docs", {
      edits: [setContent(BROKEN)],
      dryRun: true,
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.structured).toMatchObject({
      dryRun: true,
      ok: false,
      issues: [{ code: "mdx_invalid", path: "/edits/0/content" }],
      working: null,
    });
    expect(harness.calls).toEqual([]);
  });

  it("a valid dry run asks the service to validate and writes nothing", async () => {
    const { harness, outcome } = await run("edit_docs", {
      edits: [setContent(VALID)],
      dryRun: true,
    });
    expect(outcome.structured).toMatchObject({
      dryRun: true,
      ok: true,
      issues: [],
      working: { revision: 2 },
    });
    expect(harness.calls.map((entry) => entry.method)).toEqual([
      "docs.applyEdits",
    ]);
    expect(harness.written).toEqual([]);
  });

  it("writes the edits in order with the mcp origin", async () => {
    const edits = [
      { type: "create_page", sectionSlug: "default", groupIndex: null, title: "FAQ", slug: "faq" },
      setContent(VALID),
    ];
    const { harness } = await run("edit_docs", { edits });
    expect(harness.written).toEqual([
      expect.objectContaining({
        actor: { userId: OWNER, origin: "mcp" },
        edits,
      }),
    ]);
  });

  it("creates a group and its first page in one call", async () => {
    const edits = [
      { type: "create_group", sectionSlug: "default", heading: "Recipes" },
      { type: "create_page", sectionSlug: "default", groupIndex: 0, title: "Bake", slug: "bake" },
    ];
    const { harness, outcome } = await run("edit_docs", { edits });
    expect(outcome.isError).toBe(false);
    expect(harness.written).toEqual([expect.objectContaining({ edits })]);
  });

  it("does not let an agent ask create_group for a placeholder page", async () => {
    const { harness, outcome } = await run("edit_docs", {
      edits: [
        { type: "create_group", sectionSlug: "default", heading: "Recipes", starterPage: true },
      ],
    });
    expect(outcome.isError).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  it.each(["set_site_config", "reset_site_config"])(
    "rejects a %s edit",
    async (type) => {
      const { harness, outcome } = await run("edit_docs", {
        edits: [{ type, config: {} }],
      });
      expect(outcome.isError).toBe(true);
      expect(harness.written).toEqual([]);
    },
  );

  it("accepts at most 50 edits", async () => {
    const edits = Array.from({ length: 51 }, () => setContent(VALID));
    const { harness, outcome } = await run("edit_docs", { edits });
    expect(outcome.isError).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  it("maps a stale expectedRevision to conflict", async () => {
    const { outcome } = await run("edit_docs", {
      edits: [setContent(VALID)],
      expectedRevision: 0,
    });
    expect(toolError(outcome)).toMatchObject({
      code: "conflict",
      details: { currentRevision: 2 },
    });
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-028): an agent changes only the branches it created.
describe("branch ownership", () => {
  const foreignBranches = [
    ["a dashboard branch", USER_BRANCH_ID],
    ["the same member's branch from another client", OTHER_AGENT_BRANCH_ID],
    ["another member's branch from the same client", TEAMMATE_AGENT_BRANCH_ID],
  ] as const;

  it.each(foreignBranches)("write_page refuses %s and writes nothing", async (_label, branch) => {
    const { harness, outcome } = await run("write_page", { branch, href: "/install", content: VALID });
    expect(toolError(outcome)).toMatchObject({ code: "branch_not_found" });
    expect(harness.written).toEqual([]);
  });

  it.each(foreignBranches)("edit_docs refuses %s and writes nothing", async (_label, branch) => {
    const { harness, outcome } = await run("edit_docs", { branch, edits: [setContent(VALID)] });
    expect(toolError(outcome)).toMatchObject({ code: "branch_not_found" });
    expect(harness.written).toEqual([]);
  });

  it("lets an edit_docs dry run reach the service for a dashboard branch, without the ownership check", async () => {
    const { harness } = await run("edit_docs", {
      branch: USER_BRANCH_ID,
      edits: [setContent(VALID)],
      dryRun: true,
    });
    const methods = harness.calls.map((entry) => entry.method);
    expect(methods).toContain("docs.applyEdits");
    expect(methods).not.toContain("branches.list");
    expect(harness.written).toEqual([]);
  });
});

import type { OAuthScope } from "@doxahq/contracts/agent-access";
import { describe, expect, it } from "vitest";
import {
  BRANCH_ID,
  OWNER,
  PROJECT_A,
  PROJECT_B,
  PROJECT_OTHER,
  VERSION_ID,
} from "./support/fixtures";
import { createHarness, type HarnessOptions } from "./support/harness";
import { callTool, rawToolCall, toolError } from "./support/tool-calls";

interface WriteToolCase {
  name: string;
  scope: OAuthScope;
  args(projectId: string, branch?: string): Record<string, unknown>;
  check(structured: Record<string, unknown>): void;
  /** False for create_branch, which takes no branch. */
  takesBranch: boolean;
}

const PAGE = "---\ntitle: Install\n---\n\n## Steps\n\nRun it.\n";

const WRITE_TOOLS: WriteToolCase[] = [
  {
    name: "create_branch",
    scope: "docs:write",
    takesBranch: false,
    args: (projectId) => ({ projectId, name: "agent-new" }),
    check: (s) =>
      expect(s).toMatchObject({ kind: "named", name: "agent-new", revision: 0 }),
  },
  {
    name: "sync_branch",
    scope: "docs:write",
    takesBranch: true,
    args: (projectId, branch = BRANCH_ID) => ({ projectId, branch }),
    check: (s) =>
      expect(s).toEqual({
        dryRun: true,
        preview: {
          mainVersionId: VERSION_ID,
          behind: true,
          conflicts: [],
          autoResolvedCount: 0,
        },
      }),
  },
  {
    name: "build_preview",
    scope: "docs:write",
    takesBranch: true,
    args: (projectId, branch = BRANCH_ID) => ({ projectId, branch }),
    check: (s) =>
      expect(s).toMatchObject({ url: "http://preview-agent.localhost:3002" }),
  },
  {
    name: "write_page",
    scope: "docs:write",
    takesBranch: true,
    args: (projectId, branch = BRANCH_ID) => ({
      projectId,
      branch,
      href: "/install",
      content: PAGE,
    }),
    check: (s) => expect(s).toMatchObject({ working: { revision: 3 } }),
  },
  {
    name: "edit_docs",
    scope: "docs:write",
    takesBranch: true,
    args: (projectId, branch = BRANCH_ID) => ({
      projectId,
      branch,
      edits: [{ type: "rename_page", href: "/install", title: "Setup", slug: "setup" }],
    }),
    check: (s) =>
      expect(s).toMatchObject({
        dryRun: false,
        ok: true,
        issues: [],
        working: { revision: 3 },
      }),
  },
  {
    name: "update_site_settings",
    scope: "site:write",
    takesBranch: true,
    args: (projectId, branch = BRANCH_ID) => ({
      projectId,
      branch,
      update: { mode: "merge_patch", patch: { name: "Renamed" } },
    }),
    check: (s) =>
      expect(s).toMatchObject({
        siteConfig: { name: "Renamed" },
        working: { revision: 3 },
      }),
  },
];

async function call(
  name: string,
  args: Record<string, unknown>,
  options: HarnessOptions = {},
  mode: "modern" | "legacy" = "modern",
) {
  const harness = createHarness(options);
  const client = await harness.connect(mode);
  const outcome = await callTool(client, name, args);
  return { harness, outcome };
}

describe.each(WRITE_TOOLS)("$name", (tool) => {
  it("succeeds on the owner's project and passes the owner ID", async () => {
    const { harness, outcome } = await call(tool.name, tool.args(PROJECT_A), {
      scopes: [tool.scope],
    });
    expect(outcome.isError).toBe(false);
    tool.check(outcome.structured);
    expect(harness.calls.length).toBeGreaterThan(0);
    expect(
      harness.calls.every(
        (entry) => entry.userId === OWNER && entry.projectId === PROJECT_A,
      ),
    ).toBe(true);
  });

  it("answers not_found for another user's project and calls no service", async () => {
    const { harness, outcome } = await call(tool.name, tool.args(PROJECT_OTHER));
    expect(toolError(outcome).code).toBe("not_found");
    expect(harness.calls).toEqual([]);
  });

  it("answers project_not_in_grant for a project outside the grant", async () => {
    const { harness, outcome } = await call(tool.name, tool.args(PROJECT_B), {
      projectScope: { kind: "selected", projectIds: [PROJECT_A] },
    });
    expect(toolError(outcome).code).toBe("project_not_in_grant");
    expect(harness.calls).toEqual([]);
  });

  it("returns insufficient_scope to a 2025 client with only read scopes", async () => {
    const { harness, outcome } = await call(
      tool.name,
      tool.args(PROJECT_A),
      { scopes: ["projects:read", "docs:read"] },
      "legacy",
    );
    const error = toolError(outcome);
    expect(error.code).toBe("insufficient_scope");
    expect(error.details).toEqual({ requiredScope: tool.scope });
    expect(harness.calls).toEqual([]);
  });

  it("challenges a 2026 client without the scope with 403", async () => {
    const harness = createHarness({ scopes: ["docs:read"] });
    const response = await rawToolCall(harness, tool.name, tool.args(PROJECT_A));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(tool.scope);
  });

  it("records an activity row", async () => {
    const { harness } = await call(tool.name, tool.args(PROJECT_A));
    await harness.settle();
    expect(harness.activity).toEqual([
      expect.objectContaining({ tool: tool.name, projectId: PROJECT_A }),
    ]);
  });
});

describe.each(WRITE_TOOLS.filter((tool) => tool.takesBranch))(
  "$name on main",
  (tool) => {
    it("is rejected with invalid and a create_branch hint, and calls no service", async () => {
      const { harness, outcome } = await call(
        tool.name,
        tool.args(PROJECT_A, "main"),
      );
      const error = toolError(outcome);
      expect(error.code).toBe("invalid");
      expect(error.hint).toMatch(/create_branch/);
      expect(harness.calls).toEqual([]);
      expect(harness.written).toEqual([]);
    });

    it("maps an unknown branch to branch_not_found", async () => {
      const { outcome } = await call(tool.name, tool.args(PROJECT_A, PROJECT_B));
      expect(toolError(outcome).code).toBe("branch_not_found");
    });
  },
);

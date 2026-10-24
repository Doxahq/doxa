import type { OAuthScope } from "@doxahq/contracts/agent-access";
import { describe, expect, it } from "vitest";
import {
  BRANCH_ID,
  GENERATION_ID,
  OTHER_AGENT_BRANCH_ID,
  TEAMMATE_AGENT_BRANCH_ID,
  OWNER,
  PROJECT_A,
  PROJECT_B,
  PROJECT_OTHER,
  USER_BRANCH_ID,
} from "./support/fixtures";
import { createHarness, type HarnessOptions } from "./support/harness";
import { callTool, rawToolCall, toolError } from "./support/tool-calls";

interface ProjectToolCase {
  name: string;
  scope: OAuthScope;
  args(projectId: string): Record<string, unknown>;
  check(structured: Record<string, unknown>): void;
}

const PROJECT_TOOLS: ProjectToolCase[] = [
  {
    name: "get_project",
    scope: "projects:read",
    args: (projectId) => ({ projectId }),
    check: (s) =>
      expect(s).toMatchObject({
        project: { id: PROJECT_A },
        latestGeneration: { id: GENERATION_ID },
      }),
  },
  {
    name: "get_docs_structure",
    scope: "docs:read",
    args: (projectId) => ({ projectId }),
    check: (s) =>
      expect(s).toMatchObject({
        working: { revision: 4 },
        pages: [
          { href: "/", title: "Home", status: "published" },
          { href: "/install", title: "Install", status: "edited" },
        ],
      }),
  },
  {
    name: "read_page",
    scope: "docs:read",
    args: (projectId) => ({ projectId, href: "/install", branch: BRANCH_ID }),
    check: (s) =>
      expect(s).toMatchObject({
        content: "# Install\n\nWorking.",
        revision: 2,
        status: "edited",
      }),
  },
  {
    name: "search_docs",
    scope: "docs:read",
    args: (projectId) => ({ projectId, query: "install" }),
    check: (s) =>
      expect(s).toEqual({
        results: [
          {
            href: "install",
            title: "Install",
            breadcrumb: ["Docs"],
            snippet: "Run the installer.",
            anchor: "setup",
            score: 3.5,
            status: "published",
          },
        ],
        truncated: false,
        truncatedReason: null,
      }),
  },
  {
    name: "list_branches",
    scope: "docs:read",
    args: (projectId) => ({ projectId }),
    check: (s) =>
      expect(s).toMatchObject({
        branches: [
          {
            id: BRANCH_ID,
            name: "agent-install",
            createdBy: { kind: "agent", clientName: "Test Agent", isCaller: true },
          },
          { id: USER_BRANCH_ID, createdBy: { kind: "user" } },
          {
            id: OTHER_AGENT_BRANCH_ID,
            createdBy: { kind: "agent", clientName: "Other Agent", isCaller: false },
          },
          {
            id: TEAMMATE_AGENT_BRANCH_ID,
            createdBy: { kind: "agent", clientName: "Test Agent", isCaller: false },
          },
        ],
        maxBranchesPerSite: 10,
      }),
  },
  {
    name: "get_branch_status",
    scope: "docs:read",
    args: (projectId) => ({ projectId, branch: BRANCH_ID }),
    check: (s) =>
      expect(s).toMatchObject({
        branch: { id: BRANCH_ID, revision: 2 },
        behind: false,
      }),
  },
  {
    name: "get_branch_diff",
    scope: "docs:read",
    args: (projectId) => ({ projectId, branch: BRANCH_ID }),
    check: (s) =>
      expect(s).toMatchObject({
        behind: false,
        pages: [
          { href: "/install", title: "Install", change: "edited", truncated: false },
        ],
        structure: [],
        siteSettings: null,
      }),
  },
  {
    name: "search_docs",
    scope: "docs:read",
    args: (projectId) => ({ projectId, query: "install", branch: BRANCH_ID }),
    check: (s) =>
      expect(s).toMatchObject({
        results: [{ href: "install", status: "edited" }],
        truncated: false,
      }),
  },
  {
    name: "get_site_settings",
    scope: "docs:read",
    args: (projectId) => ({ projectId }),
    check: (s) =>
      expect(s).toMatchObject({
        siteConfig: { published: { name: "Demo" }, working: null },
        revision: 4,
      }),
  },
  {
    name: "list_publications",
    scope: "docs:read",
    args: (projectId) => ({ projectId, limit: 5 }),
    check: (s) =>
      expect(s).toMatchObject({
        publications: [{ kind: "editor", versionNumber: 3 }],
        nextCursor: null,
      }),
  },
  {
    name: "list_domains",
    scope: "projects:read",
    args: (projectId) => ({ projectId }),
    check: (s) =>
      expect(s).toMatchObject({
        domains: [{ hostname: "project-1111.doxa.page" }],
        customDomainLimit: 1,
      }),
  },
  {
    name: "get_generation",
    scope: "projects:read",
    args: (projectId) => ({ projectId, generationId: GENERATION_ID }),
    check: (s) =>
      expect(s).toMatchObject({
        generation: { id: GENERATION_ID, status: "succeeded" },
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

describe.each(PROJECT_TOOLS)("$name", (tool) => {
  it("returns data for the owner's project and passes the owner ID to the service", async () => {
    const { harness, outcome } = await call(tool.name, tool.args(PROJECT_A), {
      scopes: [tool.scope],
    });
    expect(outcome.isError).toBe(false);
    tool.check(outcome.structured);
    const scoped = harness.calls.filter((entry) => entry.userId !== null);
    expect(scoped.length).toBeGreaterThan(0);
    expect(
      scoped.every(
        (entry) => entry.userId === OWNER && entry.projectId === PROJECT_A,
      ),
    ).toBe(true);
  });

  it("answers not_found for another user's project and calls no service", async () => {
    const { harness, outcome } = await call(
      tool.name,
      tool.args(PROJECT_OTHER),
    );
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

  it("returns insufficient_scope to a 2025 client without the scope", async () => {
    const { harness, outcome } = await call(
      tool.name,
      tool.args(PROJECT_A),
      { scopes: [] },
      "legacy",
    );
    const error = toolError(outcome);
    expect(error.code).toBe("insufficient_scope");
    expect(error.details).toEqual({ requiredScope: tool.scope });
    expect(harness.limiterCalls).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it("challenges a 2026 client without the scope with 403", async () => {
    const harness = createHarness({ scopes: [] });
    const response = await rawToolCall(
      harness,
      tool.name,
      tool.args(PROJECT_A),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      `scope="${tool.scope}"`,
    );
  });

  it("answers rate_limited without calling the service", async () => {
    const { harness, outcome } = await call(tool.name, tool.args(PROJECT_A), {
      rateLimited: true,
    });
    const error = toolError(outcome);
    expect(error.code).toBe("rate_limited");
    expect(error.details).toEqual({ retryAfterSeconds: 60 });
    expect(harness.calls).toEqual([]);
  });
});

describe("read tool edge cases", () => {
  it("get_generation answers not_found for an unknown generation", async () => {
    const { outcome } = await call("get_generation", {
      projectId: PROJECT_A,
      generationId: PROJECT_B,
    });
    const error = toolError(outcome);
    expect(error).toMatchObject({
      code: "not_found",
      message: "Generation not found.",
    });
  });

  it("get_generation returns the last 20 events without their data", async () => {
    const { outcome } = await call("get_generation", {
      projectId: PROJECT_A,
      generationId: GENERATION_ID,
    });
    const events = outcome.structured["recentEvents"];
    expect(Array.isArray(events) ? events.length : 0).toBe(20);
    expect(JSON.stringify(events)).not.toContain("not for agents");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: 25, message: 'Wrote "Page 25".' }),
      ]),
    );
  });

  it("read_page maps a missing page to not_found", async () => {
    const { outcome } = await call("read_page", {
      projectId: PROJECT_A,
      href: "/missing",
    });
    expect(toolError(outcome).code).toBe("not_found");
  });

  it("get_branch_status maps an unknown branch to branch_not_found with a hint", async () => {
    const { outcome } = await call("get_branch_status", {
      projectId: PROJECT_A,
      branch: PROJECT_B,
    });
    expect(toolError(outcome)).toMatchObject({
      code: "branch_not_found",
      hint: "Call list_branches to see the branches.",
    });
  });

  it("rejects unknown input fields", async () => {
    const { outcome } = await call("get_project", {
      projectId: PROJECT_A,
      extra: true,
    });
    expect(outcome.isError).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { GRANT_REF, OWNER, PROJECT_A, PROJECT_B, PROJECT_TEAM, TEAM_ID, TEAM_NAME } from "./support/fixtures";
import { createHarness, type HarnessOptions } from "./support/harness";
import { callTool, rawToolCall, toolError } from "./support/tool-calls";

async function call(
  name: string,
  args: Record<string, unknown>,
  options: HarnessOptions = {},
  mode: "modern" | "legacy" = "modern",
) {
  const harness = createHarness(options);
  const client = await harness.connect(mode);
  return { harness, outcome: await callTool(client, name, args) };
}

describe("get_account", () => {
  it("describes the grant with expanded scopes, even without any scope", async () => {
    const { outcome } = await call("get_account", {}, { scopes: ["publish"] });
    expect(outcome.structured).toEqual({
      userId: OWNER,
      client: { id: "client-1", name: "Test Agent" },
      scopes: ["docs:read", "publish"],
      projectScope: { kind: "all" },
      teams: [],
    });
    expect(JSON.stringify(outcome.structured)).not.toContain(GRANT_REF);
  });

  it("shows the user's teams and roles (spec §10)", async () => {
    const { outcome } = await call("get_account", {}, { teamRole: "editor" });
    expect(outcome.structured["teams"]).toEqual([{ id: TEAM_ID, name: TEAM_NAME, role: "editor" }]);
  });

  it("lists the selected projects of the grant", async () => {
    const { outcome } = await call(
      "get_account",
      {},
      { projectScope: { kind: "selected", projectIds: [PROJECT_A] } },
    );
    expect(outcome.structured["projectScope"]).toEqual({
      kind: "selected",
      projectIds: [PROJECT_A],
    });
  });

  it("is rate limited like every read", async () => {
    const { outcome } = await call("get_account", {}, { rateLimited: true });
    expect(toolError(outcome).code).toBe("rate_limited");
  });
});

describe("list_projects", () => {
  it("lists the user's projects with docs URLs", async () => {
    const { outcome } = await call("list_projects", {});
    expect(outcome.structured).toMatchObject({
      projects: [
        { id: PROJECT_A, docsUrl: "http://project-1111.localhost:3002" },
        { id: PROJECT_B },
      ],
      nextCursor: null,
    });
  });

  it("includes the projects of the user's teams, with the team (spec §5)", async () => {
    const { outcome } = await call("list_projects", {}, { teamRole: "viewer" });
    expect(outcome.structured).toMatchObject({
      projects: [
        { id: PROJECT_A, team: null },
        { id: PROJECT_B, team: null },
        { id: PROJECT_TEAM, team: { id: TEAM_ID, name: TEAM_NAME } },
      ],
    });
  });

  it("lists only the projects of a selected grant", async () => {
    const { outcome } = await call(
      "list_projects",
      {},
      { projectScope: { kind: "selected", projectIds: [PROJECT_A] } },
    );
    expect(outcome.structured).toMatchObject({
      projects: [{ id: PROJECT_A }],
      nextCursor: null,
    });
  });

  it("pages with a cursor", async () => {
    const first = await call("list_projects", { limit: 1 });
    expect(first.outcome.structured).toMatchObject({
      projects: [{ id: PROJECT_A }],
      nextCursor: "1",
    });
    const second = await call("list_projects", { limit: 1, cursor: "1" });
    expect(second.outcome.structured).toMatchObject({
      projects: [{ id: PROJECT_B }],
      nextCursor: null,
    });
  });

  it("needs projects:read", async () => {
    const { outcome } = await call(
      "list_projects",
      {},
      { scopes: ["docs:read"] },
      "legacy",
    );
    expect(toolError(outcome)).toMatchObject({
      code: "insufficient_scope",
      details: { requiredScope: "projects:read" },
    });
    const response = await rawToolCall(
      createHarness({ scopes: [] }),
      "list_projects",
      {},
    );
    expect(response.status).toBe(403);
  });

  it("is rate limited", async () => {
    const { outcome } = await call("list_projects", {}, { rateLimited: true });
    expect(toolError(outcome).code).toBe("rate_limited");
  });
});

describe("list_github_repositories", () => {
  it("lists the user's repositories", async () => {
    const { harness, outcome } = await call("list_github_repositories", {
      limit: 2,
    });
    expect(outcome.structured).toMatchObject({
      repositories: [{ fullName: "acme/repo-1" }, { fullName: "acme/repo-2" }],
      nextCursor: "2",
    });
    expect(harness.calls).toEqual([
      { method: "github.listRepositories", userId: OWNER, projectId: null },
    ]);
  });

  it("needs projects:read", async () => {
    const { harness, outcome } = await call(
      "list_github_repositories",
      {},
      { scopes: [] },
      "legacy",
    );
    expect(toolError(outcome).code).toBe("insufficient_scope");
    expect(harness.calls).toEqual([]);
  });

  it("is rate limited", async () => {
    const { outcome } = await call(
      "list_github_repositories",
      {},
      { rateLimited: true },
    );
    expect(toolError(outcome).code).toBe("rate_limited");
  });

  it("rejects a malformed cursor", async () => {
    const { outcome } = await call("list_github_repositories", {
      cursor: "abc",
    });
    expect(outcome.isError).toBe(true);
  });
});

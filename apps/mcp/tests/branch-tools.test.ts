import { describe, expect, it } from "vitest";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { LIMIT_BRANCH_NAME } from "./support/fake-write-services";
import type { DocsBranchCreator } from "@doxahq/contracts/docs-branches";
import {
  BRANCH_ID,
  CLIENT_ID,
  OTHER,
  OTHER_AGENT_BRANCH_ID,
  OWNER,
  PROJECT_A,
  PROJECT_TEAM,
  TEAMMATE_AGENT_BRANCH_ID,
  USER_BRANCH_ID,
  VERSION_ID,
} from "./support/fixtures";
import { createHarness, type HarnessOptions } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

async function run(
  name: string,
  args: Record<string, unknown>,
  options: HarnessOptions = {},
) {
  const harness = createHarness(options);
  const client = await harness.connect("modern");
  const outcome = await callTool(client, name, { projectId: PROJECT_A, ...args });
  return { harness, outcome };
}

function methods(harness: { calls: Array<{ method: string }> }): string[] {
  return harness.calls.map((entry) => entry.method);
}

describe("create_branch", () => {
  it.each(["Agent-Caps", "agent--double", "-agent", "main", "draft"])(
    "rejects the name %s with validation_failed and issues",
    async (name) => {
      const { outcome } = await run("create_branch", { name });
      expect(toolError(outcome).code).toBe("validation_failed");
      expect(outcome.structured).toMatchObject({
        error: { issues: [{ path: "/name" }] },
      });
    },
  );

  it("starts from another branch when fromBranchId is set", async () => {
    const { outcome } = await run("create_branch", {
      name: "agent-child",
      fromBranchId: BRANCH_ID,
    });
    expect(outcome.structured).toMatchObject({
      name: "agent-child",
      createdFromBranchId: BRANCH_ID,
    });
  });

  it("lists the existing branch names when the limit is reached", async () => {
    const { harness, outcome } = await run("create_branch", {
      name: LIMIT_BRANCH_NAME,
    });
    const error = toolError(outcome);
    expect(error.code).toBe("validation_failed");
    expect(error.hint).toContain("agent-install");
    expect(outcome.structured).toMatchObject({
      error: { issues: [{ code: "branch_limit_reached" }] },
    });
    expect(methods(harness)).toEqual(["branches.create", "branches.list"]);
  });
});

describe("sync_branch", () => {
  it("previews by default and does not synchronize", async () => {
    const { harness } = await run("sync_branch", { branch: BRANCH_ID });
    expect(methods(harness)).toEqual(["branches.previewSync"]);
  });

  it("applies with dryRun false and the expected main version", async () => {
    const { harness, outcome } = await run("sync_branch", {
      branch: BRANCH_ID,
      dryRun: false,
      expectedMainVersionId: VERSION_ID,
      resolutions: [{ key: "page:/install", resolution: "mine" }],
      defaultResolution: "main",
    });
    expect(outcome.structured).toEqual({
      dryRun: false,
      synchronized: { revision: 3, changeCount: 1 },
    });
    // The ownership check (SEC-028) reads the branches first.
    expect(methods(harness)).toEqual(["branches.list", "branches.synchronize"]);
  });

  it("needs expectedMainVersionId to apply", async () => {
    const { harness, outcome } = await run("sync_branch", {
      branch: BRANCH_ID,
      dryRun: false,
    });
    const error = toolError(outcome);
    expect(error.code).toBe("invalid");
    expect(error.hint).toMatch(/dryRun true/);
    expect(harness.calls).toEqual([]);
  });

  it("maps a newer main to main_changed", async () => {
    const { outcome } = await run("sync_branch", {
      branch: BRANCH_ID,
      dryRun: false,
      expectedMainVersionId: BRANCH_ID,
    });
    expect(toolError(outcome).code).toBe("main_changed");
  });
});

describe("build_preview", () => {
  it("is an idempotent, expensive tool", async () => {
    const { harness, outcome } = await run("build_preview", { branch: BRANCH_ID });
    expect(outcome.structured).toMatchObject({ versionId: VERSION_ID });
    expect(harness.limiterCalls).toEqual(["expensive"]);
  });

  it("maps preview_rate_limited with a hint", async () => {
    const { outcome } = await run(
      "build_preview",
      { branch: BRANCH_ID },
      {
        services: (fakes) => ({
          ...fakes,
          branches: {
            ...fakes.branches,
            buildPreview: async () => {
              throw new DocsContentError("preview_rate_limited", "Too many.");
            },
          },
        }),
      },
    );
    expect(toolError(outcome)).toMatchObject({
      code: "preview_rate_limited",
      hint: expect.stringMatching(/Wait/),
    });
  });
});

describe("create_branch creator", () => {
  it("records this agent's client as the creator", async () => {
    const { outcome } = await run("create_branch", { name: "agent-new" });
    expect(outcome.structured).toMatchObject({
      name: "agent-new",
      createdBy: { kind: "agent", clientName: "Test Agent", isCaller: true },
    });
    expect(JSON.stringify(outcome.structured)).not.toContain("client-1");
  });

  it("records the acting team member, not the project owner", async () => {
    const received: Array<{ userId: string; createdBy: DocsBranchCreator }> = [];
    const harness = createHarness({
      teamRole: "editor",
      services: (fakes) => ({
        ...fakes,
        branches: {
          ...fakes.branches,
          create: async (input) => {
            received.push({ userId: input.userId, createdBy: input.createdBy });
            return fakes.branches.create(input);
          },
        },
      }),
    });
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "create_branch", {
      projectId: PROJECT_TEAM,
      name: "agent-team",
    });

    expect(outcome.isError).toBe(false);
    expect(received).toEqual([
      {
        userId: OTHER,
        createdBy: {
          kind: "agent",
          clientId: CLIENT_ID,
          clientName: "Test Agent",
          userId: OWNER,
        },
      },
    ]);
  });
});

describe("delete_branch", () => {
  it("deletes a branch that this client created", async () => {
    const { harness, outcome } = await run("delete_branch", { branch: BRANCH_ID });
    expect(outcome.isError).toBe(false);
    expect(outcome.structured).toEqual({ deletedBranchId: BRANCH_ID });
    expect(methods(harness)).toEqual(["branches.deleteOwn"]);
    expect(harness.limiterCalls).toEqual(["write"]);
  });

  it.each([
    ["a dashboard branch", USER_BRANCH_ID],
    ["the same member's branch from another client", OTHER_AGENT_BRANCH_ID],
    ["another member's branch from the same client", TEAMMATE_AGENT_BRANCH_ID],
    ["an unknown branch", VERSION_ID],
  ])("answers branch_not_found for %s", async (_label, branch) => {
    const { outcome } = await run("delete_branch", { branch });
    const error = toolError(outcome);
    expect(error).toMatchObject({
      code: "branch_not_found",
      message: "Branch not found.",
      hint: "Call list_branches to see the branches.",
    });
  });

  it("refuses main with a hint and calls no service", async () => {
    const { harness, outcome } = await run("delete_branch", { branch: "main" });
    expect(toolError(outcome).code).toBe("invalid");
    expect(harness.calls).toEqual([]);
  });

  it("tells the agent to cancel a pending publish request first", async () => {
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { outcome } = await run(
      "delete_branch",
      { branch: BRANCH_ID },
      {
        services: (fakes) => ({
          ...fakes,
          branches: {
            ...fakes.branches,
            deleteOwn: async () => {
              throw new DocsContentError(
                "publish_pending",
                "This branch has a pending publish request. Cancel the request before you delete the branch.",
                { requestId },
              );
            },
          },
        }),
      },
    );
    expect(toolError(outcome)).toMatchObject({
      code: "publish_pending",
      hint: expect.stringContaining("cancel_approval_request"),
      details: { requestId },
    });
  });

  it("is marked destructive", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === "delete_branch")?.annotations,
    ).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });
});

describe("get_branch_diff", () => {
  it("refuses main with a hint and calls no service", async () => {
    const { harness, outcome } = await run("get_branch_diff", { branch: "main" });
    expect(toolError(outcome)).toMatchObject({
      code: "invalid",
      hint: expect.stringContaining("list_branches"),
    });
    expect(harness.calls).toEqual([]);
  });

  it("maps an unknown branch to branch_not_found", async () => {
    const { outcome } = await run("get_branch_diff", { branch: VERSION_ID });
    expect(toolError(outcome).code).toBe("branch_not_found");
  });
});

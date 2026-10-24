import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  restore: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  erase: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("../../src/services/agent-access/project-access-repository", async () => {
  const { SessionOwnedProjectAccess } = await import("../support/session-owned-project-access");
  return { ProjectAccessRepository: SessionOwnedProjectAccess };
});
vi.mock("../../src/http/auth", () => ({
  withUser: (
    _context: unknown,
    handler: (userId: string) => Promise<Response>,
  ) => handler("owner"),
}));
vi.mock("../../src/services/docs-branches/publish", () => ({
  DocsBranchPublish: { fromEnv: () => ({ publish: mocks.publish }) },
}));
vi.mock("../../src/services/docs-branches/preview", () => ({
  DocsBranchPreview: { fromEnv: () => ({ build: mocks.preview }) },
}));
vi.mock("../../src/services/docs-branches/history", () => ({
  DocsBranchHistory: { fromEnv: () => ({ restore: mocks.restore }) },
}));
vi.mock("../../src/services/docs-branches/branch-service", () => ({
  DocsBranchService: {
    fromEnv: () => ({
      list: mocks.list,
      create: mocks.create,
      rename: mocks.rename,
      erase: mocks.erase,
    }),
  },
}));

import { createDocsBranchRoutes } from "../../src/routes/docs-branches";
import {
  DocsContentError,
  getDocsContentErrorStatus,
} from "../../src/services/docs-content/errors";
import { createDocsHistoryRoutes } from "../../src/routes/docs-history";

const branchId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const publicationId = "33333333-3333-4333-8333-333333333333";

function request(
  path: string,
  options: { method?: string; body?: unknown; accept?: string } = {},
) {
  const app = createApiRouter();
  app.route("/projects/:projectId/branches", createDocsBranchRoutes());
  app.route("/projects/:projectId/history", createDocsHistoryRoutes());

  return app.request(`http://localhost/projects/11111111-1111-4111-8111-111111111111${path}`, {
    method: options.method ?? "POST",
    ...(options.body === undefined
      ? {}
      : {
          headers: {
            "content-type": "application/json",
            ...(options.accept ? { accept: options.accept } : {}),
          },
          body: JSON.stringify(options.body),
        }),
  });
}

/** The `data` of each server-sent event, parsed as JSON. */
async function readEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as unknown);
}

const publishBody = {
  expectedBaseVersionId: versionId,
  expectedRevision: 5,
  eraseBranch: true,
};

describe("branch action routes", () => {
  beforeEach(() => vi.clearAllMocks());

  test.each(["agent", "mcp"])(
    "rejects %s origin on publish",
    async (origin) => {
      const response = await request(`/branches/${branchId}/publish`, {
        body: {
          expectedBaseVersionId: versionId,
          expectedRevision: 5,
          eraseBranch: true,
          origin,
        },
      });
      expect(response.status).toBe(400);
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );

  test.each(["agent", "mcp"])(
    "rejects %s origin on restore",
    async (origin) => {
      const response = await request(`/history/${publicationId}/restore`, {
        body: {
          expectedMainVersionId: versionId,
          origin,
        },
      });
      expect(response.status).toBe(400);
      expect(mocks.restore).not.toHaveBeenCalled();
    },
  );

  test("passes only validated publish input to the service", async () => {
    mocks.publish.mockResolvedValue({
      versionId,
      versionNumber: 2,
      publicationId,
      branchErased: true,
    });
    const response = await request(`/branches/${branchId}/publish`, {
      body: {
        expectedBaseVersionId: versionId,
        expectedRevision: 5,
        eraseBranch: true,
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
      branch: branchId,
      request: {
        expectedBaseVersionId: versionId,
        expectedRevision: 5,
        eraseBranch: true,
      },
    });
  });

  test("streams the publish stages, then the result", async () => {
    const result = {
      versionId,
      versionNumber: 2,
      publicationId,
      branchErased: true,
    };
    mocks.publish.mockImplementation(
      async (input: { onStage: (stage: string) => void }) => {
        input.onStage("preparing");
        input.onStage("building");
        input.onStage("optimizing");
        return result;
      },
    );

    const response = await request(`/branches/${branchId}/publish`, {
      body: publishBody,
      accept: "text/event-stream",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(await readEvents(response)).toEqual([
      { type: "stage", stage: "preparing" },
      { type: "stage", stage: "building" },
      { type: "stage", stage: "optimizing" },
      { type: "result", result },
    ]);
  });

  test("streams an expected publish failure with its status and body", async () => {
    mocks.publish.mockImplementation(
      async (input: { onStage: (stage: string) => void }) => {
        input.onStage("preparing");
        throw new DocsContentError(
          "branch_behind",
          "Main changed. Synchronize this branch first.",
        );
      },
    );

    const response = await request(`/branches/${branchId}/publish`, {
      body: publishBody,
      accept: "text/event-stream",
    });

    expect(await readEvents(response)).toEqual([
      { type: "stage", stage: "preparing" },
      {
        type: "error",
        status: getDocsContentErrorStatus("branch_behind"),
        body: {
          error: {
            message: "Main changed. Synchronize this branch first.",
            details: { code: "branch_behind" },
          },
        },
      },
    ]);
  });

  test("returns a publish blocked by MDX issues with the pages (spec 8.1)", async () => {
    const pages = [
      {
        href: "/setup",
        sourcePath: "source/setup/index.mdx",
        issues: [{ line: 7, column: 1, message: "Unknown MDX component: Bogus" }],
      },
    ];
    mocks.publish.mockRejectedValue(
      new DocsContentError("mdx_invalid", "Publish blocked: 1 page has MDX issues.", { pages }),
    );

    const response = await request(`/branches/${branchId}/publish`, { body: publishBody });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Publish blocked: 1 page has MDX issues.",
        details: { code: "mdx_invalid", pages },
      },
    });
  });

  test("streams an unexpected publish failure as an internal error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.publish.mockRejectedValue(new Error("R2 is down"));

    const response = await request(`/branches/${branchId}/publish`, {
      body: publishBody,
      accept: "text/event-stream",
    });

    expect(await readEvents(response)).toEqual([
      {
        type: "error",
        status: 500,
        body: { error: { message: "Internal server error." } },
      },
    ]);
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  test.each([
    "/branches",
    `/branches/${branchId}/sync`,
    `/branches/${branchId}/publish`,
    `/history/${publicationId}/restore`,
  ])("rejects a body that is not JSON at %s", async (path) => {
    const app = createApiRouter();
    app.route("/projects/:projectId/branches", createDocsBranchRoutes());
    app.route("/projects/:projectId/history", createDocsHistoryRoutes());

    const response = await app.request(
      `http://localhost/projects/11111111-1111-4111-8111-111111111111${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
    );

    expect(response.status).toBe(400);
  });

  test("validates a branch name before creation", async () => {
    const response = await request("/branches", {
      body: { name: "Main", from: { kind: "main" } },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        details: {
          code: "validation_failed",
          issues: [expect.objectContaining({ code: "invalid_branch_name" })],
        },
      },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test("lists named branches with their limit", async () => {
    const branch = branchDto("feature", null);

    mocks.list.mockResolvedValue({
      branches: [branch],
      maxBranchesPerSite: 10,
    });

    const response = await request("/branches", { method: "GET" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      branches: [branch],
      maxBranchesPerSite: 10,
    });
    expect(mocks.list).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("creates and renames a named branch with validated input", async () => {
    const created = branchDto("feature", null);
    const renamed = { ...created, name: "renamed" };

    mocks.create.mockResolvedValue(created);
    mocks.rename.mockResolvedValue(renamed);

    const createResponse = await request("/branches", {
      body: { name: "feature", from: { kind: "main" } },
    });
    const renameResponse = await request(`/branches/${branchId}`, {
      method: "PATCH",
      body: { name: "renamed" },
    });

    expect(createResponse.status).toBe(201);
    expect(renameResponse.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
      request: { name: "feature", from: { kind: "main" } },
    });
    expect(mocks.rename).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
      branchId,
      request: { name: "renamed" },
    });
  });

  test("rejects an origin body on erase and accepts an empty request", async () => {
    const rejected = await request(`/branches/${branchId}`, {
      method: "DELETE",
      body: { origin: "agent" },
    });

    expect(rejected.status).toBe(400);
    expect(mocks.erase).not.toHaveBeenCalled();

    mocks.erase.mockResolvedValue(undefined);

    const erased = await request(`/branches/${branchId}`, {
      method: "DELETE",
    });

    expect(erased.status).toBe(204);
    expect(mocks.erase).toHaveBeenCalledWith({
      actor: { userId: "owner", origin: "editor" },
      projectId: "11111111-1111-4111-8111-111111111111",
      branchId,
    });
  });

  test("builds a preview from an empty request", async () => {
    mocks.preview.mockResolvedValue({
      url: "https://demo-br-feature-0123456789abcdef.doxa.page",
      hostname: "demo-br-feature-0123456789abcdef.doxa.page",
      versionId,
    });

    const response = await request(`/branches/${branchId}/preview`);

    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith({
      userId: "owner",
      projectId: "11111111-1111-4111-8111-111111111111",
      branch: branchId,
    });
  });
});

function branchDto(name: string, createdFromBranchId: string | null) {
  return {
    id: branchId,
    kind: "named" as const,
    name,
    baseVersionId: versionId,
    createdFromBranchId,
    createdBy: { kind: "user" },
    revision: 0,
    changeCount: 0,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

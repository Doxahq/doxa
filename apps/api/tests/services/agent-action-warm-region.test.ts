import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const mocks = vi.hoisted(() => ({ publish: vi.fn(), restore: vi.fn() }));
vi.mock("../../src/services/docs-branches/publish", () => ({
  DocsBranchPublish: { fromEnv: () => ({ publish: mocks.publish }) },
}));
vi.mock("../../src/services/docs-branches/history", () => ({
  DocsBranchHistory: { fromEnv: () => ({ restore: mocks.restore }) },
}));
vi.mock("../../src/repositories/projects", () => ({ ProjectsRepository: vi.fn(() => ({})) }));
vi.mock("../../src/repositories/docs-branches", () => ({ DocsBranchesRepository: vi.fn(() => ({})) }));

const { actionServicesFromEnv } = await import("../../src/services/agent-actions/action-services");

const env = {} as Parameters<typeof actionServicesFromEnv>[0];
const attribution = { agentClientId: "client-1", agentClientName: "Agent", approvalRequestId: null };
const scoped = { userId: "owner-1", projectId: "project-1" };

beforeEach(() => vi.clearAllMocks());

describe("agent action services and the warm region (M45)", () => {
  test("an approve request passes the approver's pool to the publish and the restore it runs", async () => {
    const services = actionServicesFromEnv(env, { defer: () => {}, warmRegion: "us-east" });

    await services.publish.publish({
      ...scoped,
      branchId: "branch-1",
      request: { expectedBaseVersionId: "v1", expectedRevision: 1, eraseBranch: false },
      attribution,
    });
    await services.restore.restore({ ...scoped, publicationId: "p1", expectedMainVersionId: "v1", attribution });

    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ warmRegion: "us-east" });
    expect(mocks.restore.mock.calls[0]?.[0]).toMatchObject({ warmRegion: "us-east" });
  });

  test("an agent call over RPC passes no pool", async () => {
    const services = actionServicesFromEnv(env, { defer: () => {} });

    await services.publish.publish({
      ...scoped,
      branchId: "branch-1",
      request: { expectedBaseVersionId: "v1", expectedRevision: 1, eraseBranch: false },
      attribution,
    });
    await services.restore.restore({ ...scoped, publicationId: "p1", expectedMainVersionId: "v1", attribution });

    expect(mocks.publish.mock.calls[0]?.[0]).not.toHaveProperty("warmRegion");
    expect(mocks.restore.mock.calls[0]?.[0]).not.toHaveProperty("warmRegion");
  });
});

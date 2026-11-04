import { beforeEach, describe, expect, test, vi } from "vitest";
import { CLIENT_REGION_HEADER } from "@doxahq/api-bridge";
import type { DocsWarmStatus } from "@doxahq/contracts/docs-warm-job";
import { createApiRouter } from "../../src/http/app";

const OWNER = "owner-1";
const STRANGER = "stranger-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SITE = "site-1";

const mocks = vi.hoisted(() => ({
  session: { userId: "owner-1" },
  access: { store: null as null | import("../support/in-memory-project-access").InMemoryProjectAccess },
  siteIdForProject: vi.fn(),
}));

vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(mocks.session.userId),
}));
vi.mock("../../src/services/agent-access/project-access-repository", () => ({
  ProjectAccessRepository: vi.fn(() => mocks.access.store),
}));
vi.mock("../../src/repositories/docs-site-ids", () => ({
  DocsSiteIdsRepository: vi.fn(() => ({ forProject: mocks.siteIdForProject })),
}));

const { InMemoryProjectAccess } = await import("../support/in-memory-project-access");
const { createDocsWarmStatusRoutes } = await import("../../src/routes/docs-warm-status");

const status: DocsWarmStatus = {
  siteId: SITE,
  releaseId: "a".repeat(64),
  startedAt: 1_000,
  finishedAt: null,
  pools: [
    { pool: "eu-west", state: "done", updatedAt: 2_000 },
    { pool: "us-east", state: "running", updatedAt: 2_100 },
  ],
};

function request(env: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = createApiRouter();
  app.route("/projects/:projectId/warm-status", createDocsWarmStatusRoutes());
  return app.request(`http://localhost/projects/${PROJECT}/warm-status`, { headers }, env);
}

function binding(getWarmStatus: (input: { siteId: string }) => Promise<unknown>) {
  return { DOCS_CACHE_INVALIDATOR: { invalidate: vi.fn(), syncHostnames: vi.fn(), getWarmStatus: vi.fn(getWarmStatus) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.userId = OWNER;
  mocks.access.store = new InMemoryProjectAccess({ [PROJECT]: { owner: OWNER } });
  mocks.siteIdForProject.mockResolvedValue(SITE);
});

describe("GET /projects/:projectId/warm-status", () => {
  test("answers the site's warm status and the caller's own pool", async () => {
    const env = binding(async () => status);

    const response = await request(env, { [CLIENT_REGION_HEADER]: "eu-west" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status, clientRegion: "eu-west" });
    expect(env.DOCS_CACHE_INVALIDATOR.getWarmStatus).toHaveBeenCalledWith({ siteId: SITE });
    expect(mocks.siteIdForProject).toHaveBeenCalledWith(PROJECT);
  });

  test("hides another user's project like the other project routes, before any read", async () => {
    mocks.session.userId = STRANGER;
    const env = binding(async () => status);

    const response = await request(env);

    expect(response.status).toBe(404);
    expect(mocks.siteIdForProject).not.toHaveBeenCalled();
    expect(env.DOCS_CACHE_INVALIDATOR.getWarmStatus).not.toHaveBeenCalled();
  });

  test("answers a null status without the dispatcher binding", async () => {
    const response = await request({});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: null, clientRegion: null });
  });

  test("answers a null status for a dispatcher without the method", async () => {
    const response = await request({ DOCS_CACHE_INVALIDATOR: { invalidate: vi.fn(), syncHostnames: vi.fn() } });

    await expect(response.json()).resolves.toEqual({ status: null, clientRegion: null });
  });

  test("answers a null status for an answer outside the contract, an error, or another site", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const answer of [
      async () => ({ ...status, pools: [{ pool: "mars", state: "done", updatedAt: 1 }] }),
      async () => ({ ...status, siteId: "site-2" }),
      async () => {
        throw new Error("dispatcher down");
      },
    ]) {
      const response = await request(binding(answer));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: null, clientRegion: null });
    }
  });

  test("answers a null status for a project without a site", async () => {
    mocks.siteIdForProject.mockResolvedValue(null);
    const env = binding(async () => status);

    await expect((await request(env)).json()).resolves.toEqual({ status: null, clientRegion: null });
    expect(env.DOCS_CACHE_INVALIDATOR.getWarmStatus).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import type { TeamRole } from "@doxahq/contracts/teams";

const OWNER = "owner-1";
const MEMBER = "member-1";
const TEAM = "55555555-5555-4555-8555-555555555555";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const JOB = "66666666-6666-4666-8666-666666666666";

const mocks = vi.hoisted(() => ({
  session: { userId: "member-1" },
  access: { store: null as null | import("../support/in-memory-project-access").InMemoryProjectAccess },
  docs: { getOverview: vi.fn(), getPage: vi.fn(), applyEdits: vi.fn(), getMdxReport: vi.fn() },
  projects: { getForUser: vi.fn(), connectRepository: vi.fn() },
  jobs: { latestForProject: vi.fn(), findProjectId: vi.fn(), getForUser: vi.fn(), listEvents: vi.fn() },
  deleteProject: vi.fn(),
}));

vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(mocks.session.userId),
}));
vi.mock("../../src/services/agent-access/project-access-repository", () => ({
  ProjectAccessRepository: vi.fn(() => mocks.access.store),
}));
vi.mock("../../src/services/docs-content/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/docs-content/service")>();
  return { ...actual, DocsContentService: { fromEnv: () => mocks.docs } };
});
vi.mock("../../src/repositories/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/projects")>();
  return { ...actual, ProjectsRepository: vi.fn(() => mocks.projects) };
});
vi.mock("../../src/repositories/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/jobs")>();
  return { ...actual, JobsRepository: vi.fn(() => mocks.jobs) };
});
vi.mock("../../src/services/project-deletion", () => ({ deleteProject: mocks.deleteProject }));
vi.mock("../../src/utils/project-docs-urls", () => ({
  withDocsUrl: (project: unknown) => project,
  withPreferredDocsUrl: async (project: unknown) => project,
  withPreferredDocsUrls: async (projects: unknown) => projects,
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { InMemoryProjectAccess, fixtureProject } = await import("../support/in-memory-project-access");
const { createProjectRoutes } = await import("../../src/routes/projects");
const { createJobRoutes } = await import("../../src/routes/jobs");

function app() {
  const router = createApiRouter();
  router.route("/projects", createProjectRoutes());
  router.route("/jobs", createJobRoutes());
  return router;
}

function as(userId: string, role: TeamRole | null) {
  mocks.session.userId = userId;
  const store = new InMemoryProjectAccess(
    { [PROJECT]: { owner: OWNER, teamId: TEAM } },
    { [TEAM]: { [OWNER]: "owner", ...(role === null ? {} : { [MEMBER]: role }) } },
  );
  mocks.access.store = store;
  return store;
}

function request(path: string, init?: RequestInit) {
  return app().request(`http://localhost${path}`, init);
}

const pageEdit = { type: "set_page_content", href: "/install", content: "# Install\n" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.docs.getOverview.mockResolvedValue({ projectId: PROJECT });
  mocks.docs.applyEdits.mockResolvedValue({ revision: 2 });
  mocks.projects.getForUser.mockResolvedValue(fixtureProject(PROJECT, TEAM));
  mocks.jobs.latestForProject.mockResolvedValue(null);
});

describe("dashboard routes for team members (spec §5)", () => {
  test("lets a viewer read the content, with the project owner's ID for storage", async () => {
    as(MEMBER, "viewer");
    const response = await request(`/projects/${PROJECT}/content?branch=main`);
    expect(response.status).toBe(200);
    expect(mocks.docs.getOverview).toHaveBeenCalledWith({ userId: OWNER, origin: "editor" }, PROJECT, "main");
  });

  test("refuses a viewer's edit with 403 and writes nothing", async () => {
    as(MEMBER, "viewer");
    const response = await request(`/projects/${PROJECT}/content/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", edits: [pageEdit] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { code: "forbidden" } } });
    expect(mocks.docs.applyEdits).not.toHaveBeenCalled();
  });

  test("lets an editor edit", async () => {
    as(MEMBER, "editor");
    const response = await request(`/projects/${PROJECT}/content/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", edits: [pageEdit] }),
    });
    expect(response.status).toBe(200);
    expect(mocks.docs.applyEdits).toHaveBeenCalledWith(
      { userId: OWNER, origin: "editor" },
      PROJECT,
      [pageEdit],
      "main",
    );
  });

  test("answers 404 to a non-member and to a member who left", async () => {
    as(MEMBER, null);
    expect((await request(`/projects/${PROJECT}`)).status).toBe(404);
    const store = as(MEMBER, "admin");
    expect((await request(`/projects/${PROJECT}`)).status).toBe(200);
    store.leave(TEAM, MEMBER);
    expect((await request(`/projects/${PROJECT}`)).status).toBe(404);
    expect((await request(`/projects/${PROJECT}/content?branch=main`)).status).toBe(404);
  });

  test("returns the viewer's role with the project", async () => {
    as(MEMBER, "editor");
    const response = await request(`/projects/${PROJECT}`);
    expect(await response.json()).toMatchObject({ role: "editor", project: { team: { id: TEAM } } });
    expect(mocks.projects.getForUser).toHaveBeenCalledWith(OWNER, PROJECT);
  });

  test("lets only a role with project.delete delete the project", async () => {
    as(MEMBER, "admin");
    expect((await request(`/projects/${PROJECT}`, { method: "DELETE" })).status).toBe(403);
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    as(MEMBER, "owner");
    expect((await request(`/projects/${PROJECT}`, { method: "DELETE" })).status).toBe(204);
    expect(mocks.deleteProject.mock.calls[0]?.[1]).toEqual({ userId: OWNER, projectId: PROJECT });
  });

  test("lets only the project owner connect a repository from their GitHub", async () => {
    as(MEMBER, "admin");
    const response = await request(`/projects/${PROJECT}/repository`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubRepositoryId: "77777777-7777-4777-8777-777777777777" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.projects.connectRepository).not.toHaveBeenCalled();
  });

  test("shows a team generation to a member through /jobs, and hides it from others", async () => {
    mocks.jobs.findProjectId.mockResolvedValue(PROJECT);
    mocks.jobs.getForUser.mockResolvedValue({ id: JOB });
    as(MEMBER, "viewer");
    expect((await request(`/jobs/${JOB}`)).status).toBe(200);
    expect(mocks.jobs.getForUser).toHaveBeenCalledWith(OWNER, JOB);
    as(MEMBER, null);
    expect((await request(`/jobs/${JOB}`)).status).toBe(404);
    expect((await request("/jobs/not-a-uuid")).status).toBe(404);
  });
});

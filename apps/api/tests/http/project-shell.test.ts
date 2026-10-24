import {
  PROJECT_SHELL_SECTION_KEYS,
  projectShellSchema,
  type ProjectShellSectionKey,
} from "@doxahq/contracts/project-shell";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { error, json, notFound } from "../../src/http/response";
import {
  PROJECT_SHELL_SECTIONS,
  handleProjectShell,
  type ProjectShellSection,
} from "../../src/routes/project-shell";
import { createProjectRoutes } from "../../src/routes/projects";
import { InMemoryProjectAccess } from "../support/in-memory-project-access";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const TEAM = "55555555-5555-4555-8555-555555555555";
const PROJECT = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  access: null as null | InstanceType<
    typeof import("../support/in-memory-project-access").InMemoryProjectAccess
  >,
}));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("@doxahq/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("../../src/services/agent-access/project-access-repository", () => ({
  ProjectAccessRepository: vi.fn(() => mocks.access),
}));

const projectDetail = {
  project: {
    id: PROJECT,
    name: "Example",
    slug: "example",
    githubRepositoryId: null,
    repositoryFullName: null,
    publishedVersionId: null,
    docsUrl: null,
    team: null,
  },
  latestJob: null,
  role: "owner",
};

function section(
  load: ProjectShellSection["load"],
  capability: ProjectShellSection["capability"] = "project.read",
): ProjectShellSection {
  return { capability, load };
}

/** Every section answers like its endpoint, except the ones a test replaces. */
function sections(
  overrides: Partial<Record<ProjectShellSectionKey, ProjectShellSection>> = {},
): Record<ProjectShellSectionKey, ProjectShellSection> {
  return {
    project: section(async () => json(projectDetail)),
    generationReview: section(async () => json({ review: null }), "docs.read"),
    pendingMerges: section(async () => json({ merges: [] })),
    doxabot: section(async () => notFound()),
    generations: section(
      async () => json({ generations: [], nextCursor: null }),
      "generation.read",
    ),
    branches: section(
      async () => json({ branches: [], maxBranchesPerSite: 5 }),
      "docs.read",
    ),
    pendingApprovalRequests: section(async () => json({ requests: [] }), null),
    docsDomains: section(
      async () => error("Docs domains are unavailable.", 503, { code: "unavailable" }),
      "domains.read",
    ),
    ...overrides,
  };
}

function shell(
  sectionMap: Record<ProjectShellSectionKey, ProjectShellSection>,
  timeoutMs = 50,
) {
  const app = createApiRouter();
  app.get("/projects/:projectId/shell", (context) =>
    handleProjectShell(context, { sections: sectionMap, timeoutMs }),
  );
  return app;
}

let findAccess: { mock: { calls: unknown[] } };

beforeEach(() => {
  mocks.getSessionUser.mockReset();
  mocks.getSessionUser.mockResolvedValue({ id: OWNER, email: "owner@doxa.so" });
  mocks.access = new InMemoryProjectAccess(
    { [PROJECT]: { owner: OWNER, teamId: TEAM } },
    { [TEAM]: { [OWNER]: "owner", [VIEWER]: "viewer" } },
  );
  findAccess = vi.spyOn(mocks.access, "findAccess");
});

describe("GET /projects/:projectId/shell", () => {
  test("answers each section with the body of its endpoint, or its error", async () => {
    const response = await shell(sections()).request(`/projects/${PROJECT}/shell`, {}, {});

    expect(response.status).toBe(200);
    const body = projectShellSchema.parse(await response.json());
    expect(body.project).toEqual({ data: projectDetail });
    expect(body.pendingMerges).toEqual({ data: { merges: [] } });
    expect(body.doxabot).toEqual({ error: { status: 404, message: "Not found" } });
    expect(body.docsDomains).toEqual({
      error: {
        status: 503,
        message: "Docs domains are unavailable.",
        details: { code: "unavailable" },
      },
    });
    expect(Object.keys(body).sort()).toEqual([...PROJECT_SHELL_SECTION_KEYS].sort());
  });

  test("checks the session and the access once for every section", async () => {
    await shell(sections()).request(`/projects/${PROJECT}/shell`, {}, {});

    expect(mocks.getSessionUser).toHaveBeenCalledTimes(1);
    expect(findAccess).toHaveBeenCalledTimes(1);
  });

  test("reads the sections at the same time", async () => {
    let running = 0;
    let most = 0;
    const slow = (body: unknown) =>
      section(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return json(body);
      });

    await shell(
      sections({
        pendingMerges: slow({ merges: [] }),
        doxabot: slow({ settings: null }),
        project: slow(projectDetail),
      }),
    ).request(`/projects/${PROJECT}/shell`, {}, {});

    expect(most).toBe(3);
  });

  test("a failed section does not fail the others", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await shell(
      sections({
        branches: section(async () => {
          throw new Error("database unavailable");
        }, "docs.read"),
      }),
    ).request(`/projects/${PROJECT}/shell`, {}, {});

    const body = projectShellSchema.parse(await response.json());
    expect(body.branches).toEqual({
      error: { status: 500, message: "Internal server error." },
    });
    expect(body.project).toEqual({ data: projectDetail });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("a slow section times out and the others still answer", async () => {
    const started = Date.now();

    const response = await shell(
      sections({
        generations: section(
          () => new Promise<Response>(() => undefined),
          "generation.read",
        ),
      }),
      20,
    ).request(`/projects/${PROJECT}/shell`, {}, {});

    const body = projectShellSchema.parse(await response.json());
    expect(body.generations).toEqual({
      error: {
        status: 504,
        message: "This section did not answer in time.",
        details: { code: "timeout" },
      },
    });
    expect(body.pendingMerges).toEqual({ data: { merges: [] } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a section keeps the capability check of its endpoint", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: VIEWER });
    const load = vi.fn(async () => json({ ok: true }));

    const response = await shell(
      sections({ branches: section(load, "docs.write") }),
    ).request(`/projects/${PROJECT}/shell`, {}, {});

    const body = (await response.json()) as { branches: unknown };
    expect(body.branches).toEqual({
      error: {
        status: 403,
        message: "Your role on this project does not allow this action.",
        details: { code: "forbidden" },
      },
    });
    expect(load).not.toHaveBeenCalled();
  });

  test("the whole request fails as GET /projects/:projectId does", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    expect(
      (await shell(sections()).request(`/projects/${PROJECT}/shell`, {}, {})).status,
    ).toBe(401);

    mocks.getSessionUser.mockResolvedValue({ id: "stranger" });
    expect(
      (await shell(sections()).request(`/projects/${PROJECT}/shell`, {}, {})).status,
    ).toBe(404);
  });

  test("the production sections cover the contract keys with their endpoint capabilities", () => {
    expect(Object.keys(PROJECT_SHELL_SECTIONS).sort()).toEqual(
      [...PROJECT_SHELL_SECTION_KEYS].sort(),
    );
    expect(
      Object.fromEntries(
        Object.entries(PROJECT_SHELL_SECTIONS).map(([key, value]) => [
          key,
          value.capability,
        ]),
      ),
    ).toEqual({
      project: "project.read",
      generationReview: "docs.read",
      pendingMerges: "project.read",
      doxabot: "project.read",
      generations: "generation.read",
      branches: "docs.read",
      pendingApprovalRequests: null,
      docsDomains: "domains.read",
    });
  });

  test("the project routes serve the shell, not the project detail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // No database in this test: every real section fails on its own, and the
    // shell still answers with one entry per section.
    const response = await createProjectRoutes().request(
      `/${PROJECT}/shell`,
      {},
      { DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused" },
    );

    expect(response.status).toBe(200);
    const body = projectShellSchema.parse(await response.json());
    expect(Object.keys(body).sort()).toEqual([...PROJECT_SHELL_SECTION_KEYS].sort());
    expect(body.project).toHaveProperty("error");
    consoleError.mockRestore();
  });
});

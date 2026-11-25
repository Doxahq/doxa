import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  GenerationDetailDto,
  GenerationJobDto,
  GenerationsPageDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts";
import { projectGenerationCacheSchema } from "@doxahq/contracts";
import type { DoxabotProjectSettingsState } from "../../src/repositories/doxabot-settings";
import { findProjectRepositoryIssue } from "../../src/repositories/github-lifecycle";
import { ActiveGenerationConflictError } from "../../src/repositories/jobs";
import { resolveCompatibleProductionBaseline } from "../../src/repositories/production-baselines";
import { meteredActionOf } from "../../src/services/billing/generation-metering";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  projectsRepository: {
    listAccessibleForUser: vi.fn(),
    getForUser: vi.fn(),
    createForRepository: vi.fn(),
    connectRepository: vi.fn(),
  },
  createExampleProject: vi.fn(),
  authorizeProjectCreation: vi.fn(),
  deleteProject: vi.fn(),
  docsDomainsRepository: {
    listPreferredCustomHostnames: vi.fn(),
  },
  jobsRepository: {
    latestForProject: vi.fn(),
    listForProject: vi.fn(),
    getForProject: vi.fn(),
    getDetailForProject: vi.fn(),
    promoteForProject: vi.fn(),
    deleteForProject: vi.fn(),
    getStreamStateForProject: vi.fn(),
    listEvents: vi.fn(),
    listEventsAfter: vi.fn(),
    markCancelled: vi.fn(),
    addEvent: vi.fn(),
    isGenerationPaused: vi.fn(),
    activeForConcurrencyKey: vi.fn(),
  },
  productionGenerationAdmission: {
    admit: vi.fn(),
  },
  doxabotSettingsRepository: {
    getProjectState: vi.fn(),
    update: vi.fn(),
    getPublishedPreviewBaseline: vi.fn(),
  },
  previewVisibilityRepository: {
    getForProject: vi.fn(),
    updateForProject: vi.fn(),
  },
  generationCacheRepository: {
    getForProject: vi.fn(),
    clearForProject: vi.fn(),
  },
  productionBaselinesRepository: {
    findCompatiblePublished: vi.fn(),
  },
}));

vi.mock("../../src/services/agent-access/project-access-repository", async () => {
  const { SessionOwnedProjectAccess } = await import("../support/session-owned-project-access");
  return { ProjectAccessRepository: SessionOwnedProjectAccess };
});
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

vi.mock("@doxahq/auth", () => ({
  createAuth: vi.fn(),
  getSessionUser: mocks.getSessionUser,
  getTrustedOrigins: (env: { WEB_ORIGIN?: string }) =>
    [env.WEB_ORIGIN].filter(Boolean),
}));

vi.mock("../../src/repositories/projects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/repositories/projects")>();
  return {
    ...actual,
    ProjectsRepository: vi.fn(() => mocks.projectsRepository),
  };
});

vi.mock("../../src/repositories/jobs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/repositories/jobs")>();
  return {
    ...actual,
    JobsRepository: vi.fn(() => mocks.jobsRepository),
  };
});

vi.mock("../../src/repositories/doxabot-settings", () => ({
  DoxabotSettingsRepository: vi.fn(() => mocks.doxabotSettingsRepository),
}));

vi.mock("../../src/repositories/generation-cache", () => ({
  GenerationCacheRepository: vi.fn(() => mocks.generationCacheRepository),
}));

vi.mock("../../src/repositories/production-baselines", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/repositories/production-baselines")>();
  return {
    ...actual,
    ProductionBaselinesRepository: vi.fn(() => mocks.productionBaselinesRepository),
  };
});

vi.mock("../../src/repositories/preview-visibility", () => ({
  PreviewVisibilityRepository: vi.fn(() => mocks.previewVisibilityRepository),
}));

vi.mock("../../src/repositories/docs", () => ({
  DocsRepository: vi.fn(),
}));

vi.mock("../../src/repositories/docs-domains", () => ({
  DocsDomainsRepository: vi.fn(() => mocks.docsDomainsRepository),
}));

vi.mock("../../src/repositories/github", () => ({
  GitHubRepository: vi.fn(),
}));

// The repository and its installation are connected in these tests.
vi.mock("../../src/repositories/github-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/repositories/github-lifecycle")>()),
  findProjectRepositoryIssue: vi.fn(async () => null),
}));
vi.mock("../../src/services/container-generation", () => ({
  runContainerGeneration: vi.fn(),
}));

vi.mock("../../src/services/production-generation-admission", () => ({
  ProductionGenerationAdmissionService: {
    fromEnv: vi.fn(() => mocks.productionGenerationAdmission),
  },
}));

vi.mock("../../src/services/github-app", () => ({
  createInstallationAccessToken: vi.fn(),
  createRepositoryReadToken: vi.fn(),
  storeGenerationSiteAsset: vi.fn(),
  createModelAccessToken: vi.fn(async () => null),
  listInstallationRepositories: vi.fn(),
}));

vi.mock("../../src/services/github-webhook", () => ({
  verifyGitHubWebhook: vi.fn(),
}));

vi.mock("../../src/services/local-dev-user", () => ({
  ensureLocalDevUser: vi.fn(),
}));

vi.mock("../../src/services/starter-docs", () => ({
  publishStarterDocs: vi.fn(),
}));

vi.mock("../../src/services/example-docs/create-project", () => ({
  createExampleProject: mocks.createExampleProject,
}));

vi.mock("../../src/services/teams/team-service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  TeamService: { fromEnv: () => ({ authorizeProjectCreation: mocks.authorizeProjectCreation }) },
}));

vi.mock("../../src/services/project-deletion", () => ({
  deleteProject: mocks.deleteProject,
}));

const worker = (await import("../../src/index")).default;
const { ProjectDeletionError, GENERATION_ACTIVE_DELETE_MESSAGE } = await import(
  "../../src/repositories/project-deletion"
);
const { DocsDomainProvisioningError } = await import(
  "../../src/services/docs-domain-lifecycle"
);
const { CreateProjectError } = await import("../../src/repositories/projects");
const { TeamAccessError, TeamNotFoundError } = await import("../../src/services/teams/errors");

describe("project routes docs URLs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({
      id: "user-1",
      email: "user@doxa.so",
    });
    mocks.projectsRepository.listAccessibleForUser.mockResolvedValue([createProject()]);
    mocks.projectsRepository.getForUser.mockResolvedValue(createProject());
    mocks.projectsRepository.createForRepository.mockResolvedValue(
      createProject(),
    );
    mocks.docsDomainsRepository.listPreferredCustomHostnames.mockResolvedValue(
      new Map(),
    );
    mocks.jobsRepository.latestForProject.mockResolvedValue(null);
    mocks.jobsRepository.listForProject.mockResolvedValue(
      createGenerationsPage(),
    );
    mocks.jobsRepository.getForProject.mockResolvedValue(createGeneration());
    mocks.jobsRepository.getDetailForProject.mockResolvedValue(
      createGenerationDetail(),
    );
    mocks.jobsRepository.promoteForProject.mockResolvedValue({
      outcome: "promoted",
      publishedVersionId: "version-2",
    });
    mocks.jobsRepository.deleteForProject.mockResolvedValue({
      outcome: "deleted",
    });
    mocks.jobsRepository.getStreamStateForProject.mockResolvedValue({
      generation: createGeneration(),
      latestSequence: 1,
    });
    mocks.jobsRepository.listEvents.mockResolvedValue([createJobEvent()]);
    mocks.jobsRepository.listEventsAfter.mockResolvedValue([]);
    mocks.jobsRepository.markCancelled.mockResolvedValue(true);
    mocks.jobsRepository.addEvent.mockResolvedValue(createJobEvent());
    mocks.jobsRepository.isGenerationPaused.mockResolvedValue(false);
    mocks.jobsRepository.activeForConcurrencyKey.mockResolvedValue(null);
    mocks.productionGenerationAdmission.admit.mockResolvedValue(
      {
        outcome: "created",
        job: createGeneration({ status: "queued", docsVersionId: null }),
      },
    );
    mocks.doxabotSettingsRepository.getProjectState.mockResolvedValue(
      createDoxabotProjectState(),
    );
    mocks.doxabotSettingsRepository.update.mockResolvedValue(
      new Date("2026-07-23T09:00:00.000Z"),
    );
    mocks.previewVisibilityRepository.getForProject.mockResolvedValue({
      previewVisibility: "private",
    });
    mocks.previewVisibilityRepository.updateForProject.mockResolvedValue({
      previewVisibility: "public",
    });
  });

  test("lists generated Doxa preview subdomain URLs when DOCS_BASE_DOMAIN is configured", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects"),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [
        createProject({
          docsUrl: "https://demo.doxa.page",
        }),
      ],
    });
  });

  test("prefers the first ready custom domain for project docs URLs", async () => {
    mocks.docsDomainsRepository.listPreferredCustomHostnames.mockResolvedValue(
      new Map([["11111111-1111-4111-8111-111111111111", "docs.example.com"]]),
    );

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects"),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.docsDomainsRepository.listPreferredCustomHostnames).toHaveBeenCalledWith(["11111111-1111-4111-8111-111111111111"]);
    await expect(response.json()).resolves.toEqual({
      projects: [
        createProject({
          docsUrl: "https://docs.example.com",
        }),
      ],
    });
  });

  test("creates projects with generated Doxa preview subdomain URLs", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects", {
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(mocks.projectsRepository.createForRepository).toHaveBeenCalledWith({
      userId: "user-1",
      githubRepositoryId: "11111111-1111-4111-8111-111111111111",
      team: null,
    });
    expect(mocks.authorizeProjectCreation).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      project: createProject({
        docsUrl: "https://demo.doxa.page",
      }),
    });
  });

  test("creates an example project without a repository", async () => {
    mocks.createExampleProject.mockResolvedValue(
      createProject({ githubRepositoryId: null, publishedVersionId: "v-1" }),
    );
    const response = await worker.fetch(
      createMutationRequest("/projects/example", {
        body: JSON.stringify({ name: "  My Docs  " }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(mocks.createExampleProject).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "user-1", name: "My Docs", team: null, via: "web" },
    );
    expect(mocks.projectsRepository.createForRepository).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      project: createProject({
        githubRepositoryId: null,
        publishedVersionId: "v-1",
        docsUrl: "https://demo.doxa.page",
      }),
    });
  });

  test("passes the empty template to an example project", async () => {
    mocks.createExampleProject.mockResolvedValue(
      createProject({ githubRepositoryId: null, publishedVersionId: "v-1" }),
    );
    const response = await worker.fetch(
      createMutationRequest("/projects/example", {
        body: JSON.stringify({ name: "My Docs", template: "empty" }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(mocks.createExampleProject).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "user-1", name: "My Docs", template: "empty", team: null, via: "web" },
    );
  });

  test("creates a project in a team where the user's role may create one", async () => {
    const team = { id: "33333333-3333-4333-8333-333333333333", name: "Coder One" };
    mocks.authorizeProjectCreation.mockResolvedValue(team);
    mocks.createExampleProject.mockResolvedValue(
      createProject({ githubRepositoryId: null, publishedVersionId: "v-1", team }),
    );
    const response = await worker.fetch(
      createMutationRequest("/projects/example", {
        body: JSON.stringify({ name: "Team Docs", teamId: team.id }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(mocks.authorizeProjectCreation).toHaveBeenCalledWith("user-1", team.id);
    expect(mocks.createExampleProject).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "user-1", name: "Team Docs", team, via: "web" },
    );
    await expect(response.json()).resolves.toMatchObject({ project: { team } });
  });

  test("refuses a team role without project.create (403) and a team the user is not in (404)", async () => {
    const teamId = "33333333-3333-4333-8333-333333333333";
    for (const [refusal, status] of [
      [new TeamAccessError(), 403],
      [new TeamNotFoundError(), 404],
    ] as const) {
      mocks.authorizeProjectCreation.mockRejectedValueOnce(refusal);
      const response = await worker.fetch(
        createMutationRequest("/projects", {
          body: JSON.stringify({ githubRepositoryId: "11111111-1111-4111-8111-111111111111", teamId }),
        }),
        createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
        createExecutionContext(),
      );
      expect(response.status).toBe(status);
    }
    expect(mocks.projectsRepository.createForRepository).not.toHaveBeenCalled();
  });

  test("refuses a team ID that is not a UUID before any check", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/example", {
        body: JSON.stringify({ name: "Team Docs", teamId: "not-a-uuid" }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
    expect(mocks.authorizeProjectCreation).not.toHaveBeenCalled();
  });

  test("rejects an unknown example template", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/example", {
        body: JSON.stringify({ name: "My Docs", template: "blog" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.createExampleProject).not.toHaveBeenCalled();
  });

  test("rejects an example project without a name", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/example", {
        body: JSON.stringify({ name: " " }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.createExampleProject).not.toHaveBeenCalled();
  });

  test("connects a repository to a project that has none", async () => {
    mocks.projectsRepository.connectRepository.mockResolvedValue(
      createProject({ githubRepositoryId: "repo-2" }),
    );
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/repository", {
        method: "PUT",
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.projectsRepository.connectRepository).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      githubRepositoryId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("returns conflict when the project already has a repository", async () => {
    mocks.projectsRepository.connectRepository.mockRejectedValueOnce(
      new CreateProjectError(
        "repository_already_connected",
        "This project already has a connected repository.",
      ),
    );
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/repository", {
        method: "PUT",
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
  });

  test("asks for a repository before it generates docs", async () => {
    mocks.projectsRepository.getForUser.mockResolvedValue(
      createProject({ githubRepositoryId: null }),
    );
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({ GENERATION_MODE: "queue", GENERATION_QUEUE: { send: vi.fn() } }),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message:
          "Connect a GitHub repository to generate docs from your source code.",
        details: { code: "repository_required" },
      },
    });
    expect(mocks.productionGenerationAdmission.admit).not.toHaveBeenCalled();
  });

  test.each([
    ["repository_removed", "The repository was removed from the doxabot GitHub App."],
    ["repository_deleted", "The repository was deleted on GitHub."],
    ["installation_suspended", "The doxabot GitHub App is suspended on GitHub."],
    ["installation_deleted", "The doxabot GitHub App was uninstalled."],
  ] as const)("says why a %s repository cannot generate", async (reason, start) => {
    vi.mocked(findProjectRepositoryIssue).mockResolvedValueOnce(reason);
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({ GENERATION_MODE: "queue", GENERATION_QUEUE: { send: vi.fn() } }),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { message: string; details: unknown } };
    expect(body.error.details).toEqual({ code: "repository_required", reason });
    expect(body.error.message.startsWith(start)).toBe(true);
    expect(body.error.message).toContain("The site stays live.");
    expect(mocks.productionGenerationAdmission.admit).not.toHaveBeenCalled();
  });

  test("blocks project generation while generation is paused", async () => {
    mocks.jobsRepository.isGenerationPaused.mockResolvedValue(true);

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({ GENERATION_MODE: "queue", GENERATION_QUEUE: { send: vi.fn() } }),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Generation is currently paused by an administrator." },
    });
    expect(mocks.productionGenerationAdmission.admit).not.toHaveBeenCalled();
  });

  test("manual generation checks only the production concurrency key", async () => {
    const send = vi.fn();
    const env = createEnv({
      GENERATION_MODE: "queue",
      GENERATION_QUEUE: { send },
    });
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    expect(mocks.jobsRepository.activeForConcurrencyKey).toHaveBeenCalledWith(
      "publish:11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.productionGenerationAdmission.admit).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      force: false,
      seed: false,
      startedBy: { userId: "user-1", via: "web" },
    });
    expect(send).toHaveBeenCalledWith({
      jobId: "job-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
    });
    await expect(response.json()).resolves.toEqual({
      job: createGeneration({ status: "queued", docsVersionId: null }),
      outcome: "started",
      message: null,
    });
  });

  test("returns confirmation without creating or queuing an unchanged generation", async () => {
    const send = vi.fn();
    mocks.productionGenerationAdmission.admit.mockResolvedValueOnce({
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message:
        "The repository content, Doxabot instructions, and generation configuration have not changed since the current production deployment. A new generation will likely produce the same documentation.",
    });

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({
        GENERATION_MODE: "queue",
        GENERATION_QUEUE: { send },
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      job: null,
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message:
        "The repository content, Doxabot instructions, and generation configuration have not changed since the current production deployment. A new generation will likely produce the same documentation.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("passes an explicit force request to generation admission", async () => {
    const send = vi.fn();

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate?force=true"),
      createEnv({
        GENERATION_MODE: "queue",
        GENERATION_QUEUE: { send },
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    expect(mocks.productionGenerationAdmission.admit).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      force: true,
      seed: false,
      startedBy: { userId: "user-1", via: "web" },
    });
    expect(send).toHaveBeenCalledOnce();
  });

  test("passes a seeded start request to generation admission", async () => {
    const send = vi.fn();

    const response = await worker.fetch(
      createMutationRequest(
        "/projects/11111111-1111-4111-8111-111111111111/generate?force=true&seed=true",
      ),
      createEnv({
        GENERATION_MODE: "queue",
        GENERATION_QUEUE: { send },
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    expect(mocks.productionGenerationAdmission.admit).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      force: true,
      seed: true,
      startedBy: { userId: "user-1", via: "web" },
    });
  });

  test("explains when a generation is already active", async () => {
    const activeJob = createGeneration({ status: "running" });
    mocks.jobsRepository.activeForConcurrencyKey.mockResolvedValueOnce(activeJob);

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({ GENERATION_MODE: "queue" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      job: activeJob,
      outcome: "already_active",
      message:
        "A generation is already in progress for this project. No new generation was started.",
    });
    expect(mocks.productionGenerationAdmission.admit).not.toHaveBeenCalled();
  });

  test("answers with a conflict when the admission race leaves no active job", async () => {
    const send = vi.fn();
    mocks.productionGenerationAdmission.admit.mockRejectedValueOnce(
      new ActiveGenerationConflictError(),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({
        GENERATION_MODE: "queue",
        GENERATION_QUEUE: { send },
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message:
          "A generation is already in progress for this project. No new generation was started.",
        details: undefined,
      },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("does not enqueue an active job returned after an admission race", async () => {
    const send = vi.fn();
    const activeJob = createGeneration({ status: "running" });
    mocks.productionGenerationAdmission.admit.mockResolvedValueOnce({
      outcome: "already_active",
      job: activeJob,
    });

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({
        GENERATION_MODE: "queue",
        GENERATION_QUEUE: { send },
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      job: activeJob,
      outcome: "already_active",
      message:
        "A generation is already in progress for this project. No new generation was started.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("refuses a project above the plan's project limit with the plan_limit shape", async () => {
    const { PlanLimitError } = await import("@doxahq/billing");
    mocks.projectsRepository.createForRepository.mockRejectedValueOnce(
      new PlanLimitError({ key: "account.projects", limit: 1, used: 1, accountId: "acct_1", plan: "free" }),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects", {
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page", BILLING_RETURN_BASE_URL: "https://doxa.so" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Plan limit reached for account.projects.",
        details: {
          code: "plan_limit",
          key: "account.projects",
          limit: 1,
          used: 1,
          plan: "free",
          resetsAt: null,
          upgradeUrl: "https://doxa.so/dashboard/billing/acct_1",
        },
      },
    });
  });

  test("refuses a generation of a repository above the size limit", async () => {
    const send = vi.fn();
    mocks.productionGenerationAdmission.admit.mockResolvedValueOnce({
      outcome: "repository_too_large",
      sizeKb: 2_097_152,
      limitKb: 1_048_576,
      message: "This repository is 2 GB. Doxa generates docs for repositories up to 1 GB.",
    });

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generate"),
      createEnv({ GENERATION_MODE: "queue", GENERATION_QUEUE: { send } }),
      createExecutionContext(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "This repository is 2 GB. Doxa generates docs for repositories up to 1 GB.",
        details: { code: "repository_too_large", sizeKb: 2_097_152, limitKb: 1_048_576 },
      },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("returns not found when the selected repository is not available to the user", async () => {
    mocks.projectsRepository.createForRepository.mockRejectedValueOnce(
      new CreateProjectError(
        "repository_not_found",
        "GitHub repository not found.",
      ),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects", {
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "GitHub repository not found.",
      },
    });
  });

  test("returns conflict when a project already exists for the selected repository", async () => {
    mocks.projectsRepository.createForRepository.mockRejectedValueOnce(
      new CreateProjectError(
        "repository_project_exists",
        "A project already exists for doxahq/doxa-demo: Demo.",
      ),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects", {
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "A project already exists for doxahq/doxa-demo: Demo.",
      },
    });
  });

  test("returns conflict when a unique project slug cannot be allocated", async () => {
    mocks.projectsRepository.createForRepository.mockRejectedValueOnce(
      new CreateProjectError(
        "slug_unavailable",
        "Could not create a unique project slug. Try a different project name.",
      ),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects", {
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message:
          "Could not create a unique project slug. Try a different project name.",
      },
    });
  });

  test("returns generated Doxa preview subdomain URLs for project detail responses", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111"),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.jobsRepository.latestForProject).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    await expect(response.json()).resolves.toEqual({
      project: createProject({
        docsUrl: "https://demo.doxa.page",
      }),
      latestJob: null,
      role: "owner",
      // Billing spec 15.1; null while billing is off (the default).
      billing: null,
    });
  });

  test("returns the preferred custom domain for project detail responses", async () => {
    mocks.docsDomainsRepository.listPreferredCustomHostnames.mockResolvedValue(
      new Map([["11111111-1111-4111-8111-111111111111", "docs.example.com"]]),
    );

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111"),
      createEnv({ DOCS_BASE_DOMAIN: "doxa.page" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      project: createProject({
        docsUrl: "https://docs.example.com",
      }),
      latestJob: null,
      role: "owner",
      // Billing spec 15.1; null while billing is off (the default).
      billing: null,
    });
  });

  test("rejects unauthenticated Doxabot settings access", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/doxabot"),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(
      mocks.doxabotSettingsRepository.getProjectState,
    ).not.toHaveBeenCalled();
  });

  test("forbids Doxabot settings access for a non-owner", async () => {
    mocks.doxabotSettingsRepository.getProjectState.mockResolvedValueOnce(
      createDoxabotProjectState({ ownerUserId: "another-user" }),
    );

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/doxabot"),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Project owner access required.",
        details: { code: "forbidden" },
      },
    });
  });

  test("returns not found for missing Doxabot project settings", async () => {
    mocks.doxabotSettingsRepository.getProjectState.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/44444444-4444-4444-8444-444444444444/doxabot"),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Project not found.",
        details: { code: "project_not_found" },
      },
    });
  });

  test("returns Doxabot settings for an eligible private project", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/doxabot"),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settings: {
        enabled: false,
        mergeTrigger: "batched",
        batchQuietMinutes: 30,
        repositoryVisibility: "private",
        productionBranch: "main",
        repositoryDefaultBranch: "main",
        allowedBotLogins: [],
        automationWarning: null,
        available: true,
        unavailableReason: null,
        updatedAt: null,
      },
    });
  });

  test("reports public repositories as unavailable and rejects enablement", async () => {
    mocks.doxabotSettingsRepository.getProjectState.mockResolvedValue(
      createDoxabotProjectState({
        repository: {
          connected: true,
          visibility: "public",
          defaultBranch: "main",
          productionBranch: "main",
          connectionIssue: null,
        },
      }),
    );

    const readResponse = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/doxabot"),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );
    const updateResponse = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/doxabot", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      }),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      settings: {
        enabled: false,
        repositoryVisibility: "public",
        available: false,
        unavailableReason: "public_repository_disabled",
      },
    });
    expect(updateResponse.status).toBe(409);
    await expect(updateResponse.json()).resolves.toEqual({
      error: {
        message: "Doxabot cannot be enabled for this project.",
        details: { code: "public_repository_disabled" },
      },
    });
    expect(mocks.doxabotSettingsRepository.update).not.toHaveBeenCalled();
  });

  test("reports a missing initial publication and rejects enablement", async () => {
    mocks.doxabotSettingsRepository.getProjectState.mockResolvedValue(
      createDoxabotProjectState({ hasPublishedVersion: false }),
    );

    const readResponse = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/doxabot"),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );
    const updateResponse = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/doxabot", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      }),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      settings: {
        available: false,
        unavailableReason: "initial_generation_required",
      },
    });
    expect(updateResponse.status).toBe(409);
    await expect(updateResponse.json()).resolves.toEqual({
      error: {
        message: "Doxabot cannot be enabled for this project.",
        details: { code: "initial_generation_required" },
      },
    });
  });

  test("enables and disables Doxabot with a strict update payload", async () => {
    const enableResponse = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/doxabot", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      }),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );
    const disableResponse = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/doxabot", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
      createEnv({ DOXABOT_ENABLED: "true" }),
      createExecutionContext(),
    );

    expect(enableResponse.status).toBe(200);
    await expect(enableResponse.json()).resolves.toMatchObject({
      settings: { enabled: true, available: true },
    });
    expect(disableResponse.status).toBe(200);
    await expect(disableResponse.json()).resolves.toMatchObject({
      settings: { enabled: false, available: true },
    });
    expect(mocks.doxabotSettingsRepository.update).toHaveBeenNthCalledWith(
      1,
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        changes: { enabled: true },
        updatedByUserId: "user-1",
      },
    );
    expect(mocks.doxabotSettingsRepository.update).toHaveBeenNthCalledWith(
      2,
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        changes: { enabled: false },
        updatedByUserId: "user-1",
      },
    );
  });

  test("allows repeated idempotent Doxabot updates", async () => {
    const request = () =>
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/doxabot", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
    const env = createEnv({ DOXABOT_ENABLED: "true" });

    const firstResponse = await worker.fetch(
      request(),
      env,
      createExecutionContext(),
    );
    const secondResponse = await worker.fetch(
      request(),
      env,
      createExecutionContext(),
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(mocks.doxabotSettingsRepository.update).toHaveBeenCalledTimes(2);
  });

  test("lists generations for an authenticated project owner", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.projectsRepository.getForUser).toHaveBeenCalledWith(
      "user-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.jobsRepository.listForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      limit: 20,
      cursor: null,
    });
    await expect(response.json()).resolves.toEqual(createGenerationsPage());
  });

  test("rejects unauthenticated generation history requests before repository access", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Authentication required." },
    });
    expect(mocks.projectsRepository.getForUser).not.toHaveBeenCalled();
    expect(mocks.jobsRepository.listForProject).not.toHaveBeenCalled();
  });

  test("returns not found before listing generations for an inaccessible project", async () => {
    mocks.projectsRepository.getForUser.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/33333333-3333-4333-8333-333333333333/generations"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.jobsRepository.listForProject).not.toHaveBeenCalled();
  });

  test("rejects malformed generation cursors before repository access", async () => {
    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations?cursor=bad",
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Invalid generation cursor." },
    });
    expect(mocks.projectsRepository.getForUser).not.toHaveBeenCalled();
    expect(mocks.jobsRepository.listForProject).not.toHaveBeenCalled();
  });

  test("returns a generation only when it belongs to the owned project", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.jobsRepository.getDetailForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-1",
    });
    await expect(response.json()).resolves.toEqual({
      generation: createGenerationDetail(),
    });
  });

  test("returns not found for a cross-project generation", async () => {
    mocks.jobsRepository.getDetailForProject.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/other-job",
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Not found" },
    });
  });

  test("promotes a generation and returns its refreshed detail", async () => {
    const promoted = createGenerationDetail({
      deployment: {
        ...createGenerationDetail().deployment,
        isCurrent: true,
        state: "live",
      },
    });
    mocks.jobsRepository.getDetailForProject.mockResolvedValueOnce(promoted);

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generations/job-1/promote"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.jobsRepository.promoteForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-1",
    });
    await expect(response.json()).resolves.toEqual({
      generation: promoted,
      publishedVersionId: "version-2",
    });
  });

  test("returns the machine-readable promotion block reason", async () => {
    mocks.jobsRepository.promoteForProject.mockResolvedValueOnce({
      outcome: "blocked",
      reason: "already_production",
    });

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generations/job-1/promote"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "already_production",
    });
    expect(mocks.jobsRepository.getDetailForProject).not.toHaveBeenCalled();
  });

  test("deletes a generation and returns no content", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generations/job-1", {
        method: "DELETE",
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(mocks.jobsRepository.deleteForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-1",
    });
  });

  test("deletes a project for its owner", async () => {
    mocks.deleteProject.mockResolvedValueOnce({
      projectId: "11111111-1111-4111-8111-111111111111",
      siteId: "site-1",
      storageEntryIds: ["entry-1"],
    });

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111", { method: "DELETE" }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(mocks.deleteProject).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("does not reveal a project that the user cannot delete", async () => {
    mocks.deleteProject.mockRejectedValueOnce(
      new ProjectDeletionError("project_not_found", "Project not found."),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/22222222-2222-4222-8222-222222222222", { method: "DELETE" }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });

  test("refuses to delete a project while a generation runs", async () => {
    mocks.deleteProject.mockRejectedValueOnce(
      new ProjectDeletionError(
        "generation_active",
        GENERATION_ACTIVE_DELETE_MESSAGE,
      ),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111", { method: "DELETE" }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: GENERATION_ACTIVE_DELETE_MESSAGE,
        details: { code: "generation_active" },
      },
    });
  });

  test("keeps the project when a custom hostname cannot be removed", async () => {
    mocks.deleteProject.mockRejectedValueOnce(
      new DocsDomainProvisioningError("Cloudflare is unavailable.", 502),
    );

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111", { method: "DELETE" }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(502);
  });

  test("returns the machine-readable deletion block reason", async () => {
    mocks.jobsRepository.deleteForProject.mockResolvedValueOnce({
      outcome: "blocked",
      reason: "serving_preview",
    });

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generations/job-1", {
        method: "DELETE",
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "serving_preview",
    });
  });

  test.each(["queued", "running"] as const)(
    "lets the project owner cancel a %s generation",
    async (status) => {
      const active = createGeneration({ status, docsVersionId: null });
      const cancelled = createGeneration({
        status: "cancelled",
        docsVersionId: null,
        errorMessage: "Cancelled by user.",
      });
      const cancelledDetail = createGenerationDetail({
        ...cancelled,
        actions: {
          canPromote: false,
          canDelete: true,
          promoteBlockedReason: "not_succeeded",
          deleteBlockedReason: null,
          canRerun: false,
          rerunBlockedReason: "not_finished",
          canResume: false,
          resumeBlockedReason: "not_resumable",
        },
      });
      mocks.jobsRepository.getForProject.mockResolvedValueOnce(active);
      mocks.jobsRepository.getDetailForProject.mockResolvedValueOnce(
        cancelledDetail,
      );
      const destroy = vi.fn(async () => Response.json({ ok: true }));

      const response = await worker.fetch(
        createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generations/job-1/cancel"),
        createEnv({ AGENT_CONTAINER: { fetch: destroy } }),
        createExecutionContext(),
      );

      expect(response.status).toBe(200);
      expect(mocks.jobsRepository.getForProject).toHaveBeenNthCalledWith(1, {
        userId: "user-1",
        projectId: "11111111-1111-4111-8111-111111111111",
        jobId: "job-1",
      });
      expect(mocks.jobsRepository.markCancelled).toHaveBeenCalledWith(
        "job-1",
        "Cancelled by user.",
        "user_cancel_requested",
        { requestedByUserId: "user-1" },
        // A person's cancel stores no check text: the check uses the default.
        undefined,
      );
      expect(destroy).toHaveBeenCalledOnce();
      await expect(response.json()).resolves.toEqual({
        generation: cancelledDetail,
      });
    },
  );

  test("does not reveal or cancel an inaccessible generation", async () => {
    mocks.jobsRepository.getForProject.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      createMutationRequest("/projects/33333333-3333-4333-8333-333333333333/generations/job-1/cancel"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.jobsRepository.markCancelled).not.toHaveBeenCalled();
  });

  test("returns conflict when the generation is already terminal", async () => {
    mocks.jobsRepository.markCancelled.mockResolvedValueOnce(false);

    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generations/job-1/cancel"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Generation has already finished." },
    });
  });

  test("lists events only after resolving the generation through project ownership", async () => {
    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/events",
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.jobsRepository.getForProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-1",
    });
    expect(mocks.jobsRepository.listEvents).toHaveBeenCalledWith("job-1");
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          ...createJobEvent(),
          data: null,
          phase: "publish",
          level: "info",
        },
      ],
    });
  });

  test("streams resumable generation events for the authenticated project owner", async () => {
    mocks.jobsRepository.listEventsAfter
      .mockResolvedValueOnce([createJobEvent()])
      .mockResolvedValue([]);

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/stream",
        {
          headers: { origin: "https://doxa.so", "last-event-id": "0" },
        },
      ),
      createEnv({ GENERATION_STREAM_TERMINAL_GRACE_MS: "0" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-store, no-transform",
    );
    expect(mocks.jobsRepository.listEventsAfter).toHaveBeenCalledWith(
      "job-1",
      0,
      100,
    );

    const body = await response.text();
    expect(body).toContain("event: snapshot");
    expect(body).toContain("event: event");
    expect(body).toContain("id: 1");
    expect(body).toContain("event: complete");
  });

  test("streams only the generation log and leaves hidden events out", async () => {
    mocks.jobsRepository.listEventsAfter
      .mockResolvedValueOnce([
        createJobEvent({
          id: "event-1",
          sequence: 1,
          source: "container",
          type: "container_stage_booted",
          message: "Agent container started write stage.",
          data: { model: "claude-haiku-5-5", stage: "write" },
        }),
        createJobEvent({ id: "event-2", sequence: 2 }),
      ])
      .mockResolvedValue([]);

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/stream",
        {
          headers: { origin: "https://doxa.so", "last-event-id": "0" },
        },
      ),
      createEnv({ GENERATION_STREAM_TERMINAL_GRACE_MS: "0" }),
      createExecutionContext(),
    );

    const body = await response.text();
    expect(body).not.toContain("claude-haiku-5-5");
    expect(body).not.toContain("Agent container");
    expect(body).not.toContain("id: 1\n");
    expect(body).toContain("id: 2\n");
    expect(body).toContain('"phase":"publish"');
    expect(body).toContain("event: complete");
  });

  test("lists credit events with their meter data and leaves shadow credit events out", async () => {
    mocks.jobsRepository.listEvents.mockResolvedValueOnce([
      createJobEvent({
        id: "event-1",
        sequence: 1,
        source: "api",
        type: "credits",
        message: "Credits.",
        data: { usedCredits: 9, holdCredits: 20, capCredits: 30, fromPaygCredits: 0, shadow: true },
      }),
      createJobEvent({
        id: "event-2",
        sequence: 2,
        source: "api",
        type: "credits",
        message: "Credits.",
        data: { usedCredits: 120, holdCredits: 300, capCredits: 3000, fromPaygCredits: 5, shadow: false, accountId: "acct-1" },
      }),
      createJobEvent({
        id: "event-3",
        sequence: 3,
        source: "api",
        type: "credits_stopped",
        message: "Stopped.",
        data: { reason: "credits_exhausted", finishedPageCount: 4, outcome: "stopped_credits", terminal: true },
      }),
    ]);

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/events",
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: JobEventDto[] };
    expect(body.events.map((event) => [event.type, event.data])).toEqual([
      ["credits", { usedCredits: 120, jobUsedCredits: 120, holdCredits: 300, capCredits: 3000, fromPaygCredits: 5, shadow: false }],
      ["credits_stopped", { reason: "credits_exhausted", finishedPageCount: 4 }],
    ]);
  });

  test("streams credit events with their meter data and leaves shadow credit events out", async () => {
    mocks.jobsRepository.listEventsAfter
      .mockResolvedValueOnce([
        createJobEvent({
          id: "event-1",
          sequence: 1,
          source: "api",
          type: "credits",
          message: "Credits.",
          data: { usedCredits: 9, holdCredits: 20, capCredits: 30, fromPaygCredits: 0, shadow: true },
        }),
        createJobEvent({
          id: "event-2",
          sequence: 2,
          source: "api",
          type: "credits",
          message: "Credits.",
          data: { usedCredits: 120, holdCredits: 300, capCredits: 3000, fromPaygCredits: 5, shadow: false, accountId: "acct-1" },
        }),
        createJobEvent({
          id: "event-3",
          sequence: 3,
          source: "api",
          type: "credits_stopped",
          message: "Stopped.",
          data: { reason: "credit_cap", finishedPageCount: 7, outcome: "stopped_credits", terminal: true },
        }),
      ])
      .mockResolvedValue([]);

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/stream",
        {
          headers: { origin: "https://doxa.so", "last-event-id": "0" },
        },
      ),
      createEnv({ GENERATION_STREAM_TERMINAL_GRACE_MS: "0" }),
      createExecutionContext(),
    );

    const body = await response.text();
    expect(body).not.toContain("id: 1\n");
    expect(body).not.toContain('"shadow":true');
    expect(body).not.toContain("acct-1");
    expect(body).toContain("id: 2\n");
    expect(body).toContain('"data":{"usedCredits":120,"jobUsedCredits":120,"holdCredits":300,"capCredits":3000,"fromPaygCredits":5,"shadow":false}');
    expect(body).toContain("id: 3\n");
    expect(body).toContain('"data":{"reason":"credit_cap","finishedPageCount":7}');
  });

  test("rejects generation streams from untrusted origins before authentication", async () => {
    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/stream",
        {
          headers: { origin: "https://evil.example" },
        },
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(
      mocks.jobsRepository.getStreamStateForProject,
    ).not.toHaveBeenCalled();
  });

  test("rejects malformed generation stream cursors before authentication", async () => {
    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/stream?after=-1",
        {
          headers: { origin: "https://doxa.so" },
        },
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(
      mocks.jobsRepository.getStreamStateForProject,
    ).not.toHaveBeenCalled();
  });

  test("does not reveal cross-project generations through the stream", async () => {
    mocks.jobsRepository.getStreamStateForProject.mockResolvedValueOnce(null);

    const response = await worker.fetch(
      new Request(
        "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/other-job/stream",
        {
          headers: { origin: "https://doxa.so" },
        },
      ),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Not found" },
    });
  });

  test("does not expose internal stream failures to the browser", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      mocks.jobsRepository.listEventsAfter.mockRejectedValueOnce(
        new Error("database credential should stay private"),
      );

      const response = await worker.fetch(
        new Request(
          "https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generations/job-1/stream",
          {
            headers: { origin: "https://doxa.so" },
          },
        ),
        createEnv(),
        createExecutionContext(),
      );
      const body = await response.text();

      expect(body).toContain("Generation stream interrupted.");
      expect(body).not.toContain("database credential should stay private");
      expect(consoleError).toHaveBeenCalledWith(
        "Generation event stream failed.",
        {
          generationId: "job-1",
          message: "database credential should stay private",
        },
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("rejects project mutations without an origin before auth lookup", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects", {
        method: "POST",
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.projectsRepository.createForRepository).not.toHaveBeenCalled();
  });

  test("returns the project generation preview visibility", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/preview-visibility"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(
      mocks.previewVisibilityRepository.getForProject,
    ).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
    });
    await expect(response.json()).resolves.toEqual({
      previewVisibility: "private",
    });
  });

  test("updates the project generation preview visibility", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/preview-visibility", {
        method: "PUT",
        body: JSON.stringify({ previewVisibility: "public" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(
      mocks.previewVisibilityRepository.updateForProject,
    ).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      previewVisibility: "public",
    });
    await expect(response.json()).resolves.toEqual({
      previewVisibility: "public",
    });
  });

  test("rejects an invalid generation preview visibility", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/preview-visibility", {
        method: "PUT",
        body: JSON.stringify({ previewVisibility: "team" }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(
      mocks.previewVisibilityRepository.updateForProject,
    ).not.toHaveBeenCalled();
  });

  test("rejects project mutations from untrusted origins", async () => {
    const response = await worker.fetch(
      createMutationRequest("/projects", {
        body: JSON.stringify({
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        }),
        headers: { origin: "https://evil.example" },
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.projectsRepository.createForRepository).not.toHaveBeenCalled();
  });

  test("falls back to legacy docs runtime URLs when DOCS_BASE_DOMAIN is not configured", async () => {
    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects"),
      createEnv({ DOCS_RUNTIME_URL: "https://preview.doxa.so" }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [
        createProject({
          docsUrl: "https://preview.doxa.so/demo",
        }),
      ],
    });
  });
});

describe("project generation cache: the next pull request run (decision D21)", () => {
  const cache = { siteId: "site-1", clearedAt: null };
  const baseline = {
    versionId: "version-1",
    sourceRevision: "abc123",
    sourceTreeHash: "tree-1",
    generatorFingerprint: null,
    siteId: "site-1",
    generationStatePrefix: "sites/site-1/generation-state/version-1",
  };
  const published = { versionId: "version-1", sourceRevision: "abc123" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "user@doxa.so" });
    mocks.projectsRepository.getForUser.mockResolvedValue(createProject());
    mocks.jobsRepository.latestForProject.mockResolvedValue(null);
    mocks.generationCacheRepository.getForProject.mockResolvedValue(cache);
  });

  async function readCache(): Promise<Response> {
    return worker.fetch(
      new Request("https://api.doxa.so/projects/11111111-1111-4111-8111-111111111111/generation-cache"),
      createEnv(),
      createExecutionContext(),
    );
  }

  async function readCacheBody() {
    const response = await readCache();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { generationCache: unknown };
    return projectGenerationCacheSchema.parse(body.generationCache);
  }

  test("is cold, a Full generation, without a published baseline", async () => {
    mocks.doxabotSettingsRepository.getPublishedPreviewBaseline.mockResolvedValue(null);
    mocks.productionBaselinesRepository.findCompatiblePublished.mockResolvedValue(null);
    expect(await readCacheBody()).toEqual({
      ...cache,
      nextPullRequestRunCold: true,
      nextPullRequestRunAction: "generation.run",
      nextGenerationRunCold: true,
    });
    expect(mocks.doxabotSettingsRepository.getPublishedPreviewBaseline).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.productionBaselinesRepository.findCompatiblePublished).toHaveBeenCalledWith({
      projectId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("is warm, an Update run, with a compatible published baseline", async () => {
    mocks.doxabotSettingsRepository.getPublishedPreviewBaseline.mockResolvedValue(published);
    mocks.productionBaselinesRepository.findCompatiblePublished.mockResolvedValue(baseline);
    expect(await readCacheBody()).toMatchObject({
      nextPullRequestRunCold: false,
      nextPullRequestRunAction: "doxabot.run",
      nextGenerationRunCold: false,
    });
  });

  test("a published version without saved run state: the page says warm, and a pull request run bills as an Update run", async () => {
    // Pull request admission reads this row as `context.publishedBaseline`.
    const row = {
      publishedVersionId: "version-1",
      publishedSourceRevision: "abc123",
      publishedVersionCreatedAt: new Date("2026-11-10T00:00:00.000Z"),
      generationBaselineResetAt: null,
    };
    const { toPublishedPreviewBaseline } = await vi.importActual<
      typeof import("../../src/repositories/doxabot-settings")
    >("../../src/repositories/doxabot-settings");
    const admissionBaseline = toPublishedPreviewBaseline(row);
    expect(admissionBaseline).toEqual(published);
    // The stricter rule of a generation that a person starts finds no saved run state.
    const compatible = resolveCompatibleProductionBaseline(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        publishedVersionId: "version-1",
        versionId: "version-1",
        siteId: "site-1",
        versionChannel: "production",
        sourceRevision: "abc123",
        sourceTreeHash: null,
        generatorFingerprint: null,
        generationStatePrefix: "",
        versionCreatedAt: row.publishedVersionCreatedAt,
        generationBaselineResetAt: null,
      },
      { projectId: "11111111-1111-4111-8111-111111111111" },
    );
    expect(compatible).toBeNull();

    mocks.doxabotSettingsRepository.getPublishedPreviewBaseline.mockResolvedValue(admissionBaseline);
    mocks.productionBaselinesRepository.findCompatiblePublished.mockResolvedValue(compatible);
    const view = await readCacheBody();
    expect(view).toMatchObject({
      nextPullRequestRunCold: false,
      nextPullRequestRunAction: "doxabot.run",
      nextGenerationRunCold: true,
    });
    // The preview job that admission creates from this baseline is metered as the page says.
    expect(
      meteredActionOf({
        publicationMode: "preview",
        trigger: "doxabot",
        baselineVersionId: admissionBaseline?.versionId ?? null,
      }),
    ).toBe(view.nextPullRequestRunAction);
  });

  test("Clear cache answers the cache with the next runs cold", async () => {
    const clearedAt = "2026-11-15T10:00:00.000Z";
    mocks.generationCacheRepository.clearForProject.mockResolvedValue({ ...cache, clearedAt });
    // Both lookups ignore versions from before the clear.
    mocks.doxabotSettingsRepository.getPublishedPreviewBaseline.mockResolvedValue(null);
    mocks.productionBaselinesRepository.findCompatiblePublished.mockResolvedValue(null);
    const response = await worker.fetch(
      createMutationRequest("/projects/11111111-1111-4111-8111-111111111111/generation-cache/clear"),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { generationCache: unknown };
    expect(projectGenerationCacheSchema.parse(body.generationCache)).toEqual({
      siteId: "site-1",
      clearedAt,
      nextPullRequestRunCold: true,
      nextPullRequestRunAction: "generation.run",
      nextGenerationRunCold: true,
    });
  });

  test("a version from before Clear cache is no pull request baseline", async () => {
    const { toPublishedPreviewBaseline } = await vi.importActual<
      typeof import("../../src/repositories/doxabot-settings")
    >("../../src/repositories/doxabot-settings");
    expect(
      toPublishedPreviewBaseline({
        publishedVersionId: "version-1",
        publishedSourceRevision: "abc123",
        publishedVersionCreatedAt: new Date("2026-11-10T00:00:00.000Z"),
        generationBaselineResetAt: new Date("2026-11-15T10:00:00.000Z"),
      }),
    ).toBeNull();
  });

  test("answers 404 for a project without a site, and reads no baseline", async () => {
    mocks.generationCacheRepository.getForProject.mockResolvedValue(null);
    expect((await readCache()).status).toBe(404);
    expect(mocks.productionBaselinesRepository.findCompatiblePublished).not.toHaveBeenCalled();
    expect(mocks.doxabotSettingsRepository.getPublishedPreviewBaseline).not.toHaveBeenCalled();
  });
});

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    WEB_ORIGIN: "https://doxa.so",
    GENERATION_QUEUE: { send: vi.fn() },
    DOCS_BUCKET: {},
    ...overrides,
  } as never;
}

function createMutationRequest(
  pathname: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", "https://doxa.so");

  return new Request(`https://api.doxa.so${pathname}`, {
    ...init,
    method: init.method ?? "POST",
    headers,
  });
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function createProject(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Demo",
    slug: "demo",
    githubRepositoryId: "repo-1",
    repositoryFullName: "acme/demo",
    publishedVersionId: null,
    docsUrl: null,
    team: null,
    ...overrides,
  };
}

function createDoxabotProjectState(
  overrides: Partial<DoxabotProjectSettingsState> = {},
): DoxabotProjectSettingsState {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "user-1",
    repository: {
      connected: true,
      visibility: "private",
      defaultBranch: "main",
      productionBranch: "main",
      connectionIssue: null,
    },
    hasPublishedVersion: true,
    storedEnabled: false,
    mergeTrigger: "batched",
    batchQuietMinutes: 30,
    allowedBotLogins: [],
    automationWarning: null,
    updatedAt: null,
    ...overrides,
  };
}

function createGeneration(
  overrides: Partial<GenerationJobDto> = {},
): GenerationJobDto {
  return {
    id: "job-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    status: "succeeded",
    docsVersionId: "version-1",
    errorMessage: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:02:00.000Z",
    ...overrides,
  };
}

function createGenerationDetail(
  overrides: Partial<GenerationDetailDto> = {},
): GenerationDetailDto {
  return {
    ...createGeneration(),
    trigger: "manual",
    author: {
      kind: "user",
      displayName: "octocat",
      githubLogin: "octocat",
      avatarUrl: null,
    },
    source: {
      provider: "github",
      repositoryFullName: "doxa/demo",
      repositoryUrl: "https://github.com/doxa/demo",
      branch: "main",
      branchUrl: "https://github.com/doxa/demo/tree/main",
      commit: {
        revision: "a".repeat(40),
        shortRevision: "aaaaaaa",
        url: `https://github.com/doxa/demo/commit/${"a".repeat(40)}`,
        message: null,
      },
      changeProposal: null,
    },
    deployment: {
      environment: "production",
      isCurrent: false,
      state: "replaced",
      docsVersionId: "version-1",
      versionNumber: 1,
      visitUrl: null,
      domains: [],
    },
    actions: {
      canPromote: true,
      canDelete: true,
      promoteBlockedReason: null,
      deleteBlockedReason: null,
      canRerun: false,
      rerunBlockedReason: "not_finished",
      canResume: false,
      resumeBlockedReason: "not_resumable",
    },
    rerunLinks: { rerunOfId: null, rerunId: null },
    flaggedPages: [],
    referenceSource: null,
    ...overrides,
  };
}

function createGenerationsPage(
  overrides: Partial<GenerationsPageDto> = {},
): GenerationsPageDto {
  return {
    generations: [createGeneration()],
    nextCursor: null,
    ...overrides,
  };
}

function createJobEvent(overrides: Partial<JobEventDto> = {}): JobEventDto {
  return {
    id: "event-1",
    jobId: "job-1",
    sequence: 1,
    source: "worker",
    type: "published",
    message: "Docs published.",
    data: { versionId: "version-1" },
    createdAt: "2026-07-18T12:02:00.000Z",
    ...overrides,
  };
}

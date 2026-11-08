import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  GenerationDetailDto,
  GenerationJobDto,
  GenerationsPageDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts";
import type { DoxabotProjectSettingsState } from "../../src/repositories/doxabot-settings";
import { ActiveGenerationConflictError } from "../../src/repositories/jobs";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  projectsRepository: {
    listAccessibleForUser: vi.fn(),
    getForUser: vi.fn(),
    createForRepository: vi.fn(),
    connectRepository: vi.fn(),
  },
  createExampleProject: vi.fn(),
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
  },
  previewVisibilityRepository: {
    getForProject: vi.fn(),
    updateForProject: vi.fn(),
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
    });
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
      { userId: "user-1", name: "My Docs" },
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
      { userId: "user-1", name: "My Docs", template: "empty" },
    );
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
    },
    hasPublishedVersion: true,
    storedEnabled: false,
    mergeTrigger: "batched",
    batchQuietMinutes: 30,
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

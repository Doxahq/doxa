import type {
  GenerateJobMessage,
  GenerationJobDto,
  ProjectDto,
} from "@doxahq/contracts";
import { REPOSITORY_REQUIRED_MESSAGE } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

// container-generation (reached through the dispatcher factory) imports
// Worker-only modules.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import { ActiveGenerationConflictError } from "../../src/repositories/jobs";
import {
  ContainerInlineGenerationDispatcher,
  StarterDevGenerationDispatcher,
  UnsupportedModeGenerationDispatcher,
  type DispatchResult,
  type GenerationDispatcher,
} from "../../src/services/generation-dispatch";
import {
  GenerationStartService,
  type GenerationAdmission,
  type GenerationStartInput,
  type GenerationStartJobsStore,
  type GenerationStartProjectsStore,
} from "../../src/services/generation-start";
import { repositoryRequiredMessage } from "../../src/services/repository-required-message";
import type { ProductionGenerationAdmission } from "../../src/services/production-generation-admission";

const START: GenerationStartInput = {
  userId: "user-1",
  projectId: "project-1",
  force: false,
};

class InMemoryProjects implements GenerationStartProjectsStore {
  constructor(private readonly projects: ProjectDto[]) {}

  async getForUser(_userId: string, projectId: string) {
    return this.projects.find((project) => project.id === projectId) ?? null;
  }
}

class InMemoryJobs implements GenerationStartJobsStore {
  paused = false;
  activeByKey = new Map<string, GenerationJobDto>();
  failed: Array<{ jobId: string; message: string }> = [];

  async isGenerationPaused() {
    return this.paused;
  }

  async activeForConcurrencyKey(key: string) {
    return this.activeByKey.get(key) ?? null;
  }

  async markFailed(jobId: string, message: string) {
    this.failed.push({ jobId, message });
  }
}

class FakeAdmission implements GenerationAdmission {
  calls: GenerationStartInput[] = [];

  constructor(
    private readonly result: () => Promise<ProductionGenerationAdmission>,
  ) {}

  admit(input: GenerationStartInput) {
    this.calls.push(input);
    return this.result();
  }
}

class RecordingDispatcher implements GenerationDispatcher {
  messages: GenerateJobMessage[] = [];

  constructor(
    private readonly result: DispatchResult = {
      status: "dispatched",
      job: null,
    },
  ) {}

  async dispatch(message: GenerateJobMessage) {
    this.messages.push(message);
    return this.result;
  }
}

function setup(
  options: {
    project?: ProjectDto;
    admission?: () => Promise<ProductionGenerationAdmission>;
    dispatchResult?: DispatchResult;
  } = {},
) {
  const projects = new InMemoryProjects(
    options.project ? [options.project] : [project()],
  );
  const jobs = new InMemoryJobs();
  const admission = new FakeAdmission(
    options.admission ??
      (async () => ({ outcome: "created", job: job({ status: "queued" }) })),
  );
  const dispatcher = new RecordingDispatcher(options.dispatchResult);
  const service = new GenerationStartService({
    projects,
    jobs,
    admission,
    dispatcher,
  });
  return { service, jobs, admission, dispatcher };
}

describe("GenerationStartService", () => {
  test("reports not_found when the user cannot see the project", async () => {
    const { service, admission } = setup();

    await expect(
      service.start({ ...START, projectId: "missing" }),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(admission.calls).toEqual([]);
  });

  test("reports repository_required when no repository is connected", async () => {
    const { service, admission } = setup({
      project: project({ githubRepositoryId: null }),
    });

    await expect(service.start(START)).resolves.toEqual({
      outcome: "repository_required",
    });
    expect(admission.calls).toEqual([]);
  });

  test.each(["repository_removed", "repository_deleted", "installation_suspended", "installation_deleted"] as const)(
    "refuses a repository with %s before admission",
    async (reason) => {
      const { admission } = setup();
      const service = new GenerationStartService({
        projects: new InMemoryProjects([project()]),
        repositoryIssue: async () => reason,
        jobs: new InMemoryJobs(),
        admission,
        dispatcher: new RecordingDispatcher(),
      });

      await expect(service.start(START)).resolves.toEqual({ outcome: "repository_required", reason });
      expect(admission.calls).toEqual([]);
    },
  );

  test("gives each lost-repository reason its own message", () => {
    expect(repositoryRequiredMessage()).toBe(REPOSITORY_REQUIRED_MESSAGE);
    const messages = (["repository_removed", "repository_deleted", "installation_suspended", "installation_deleted"] as const)
      .map((reason) => repositoryRequiredMessage(reason));
    expect(new Set(messages).size).toBe(4);
    for (const message of messages) {
      expect(message).not.toBe(REPOSITORY_REQUIRED_MESSAGE);
      expect(message).toContain("The site stays live.");
    }
  });

  test("reports paused when an administrator paused generation", async () => {
    const { service, jobs, admission } = setup();
    jobs.paused = true;

    await expect(service.start(START)).resolves.toEqual({ outcome: "paused" });
    expect(admission.calls).toEqual([]);
  });

  test("reports already_active for the production concurrency key", async () => {
    const { service, jobs, admission } = setup();
    const active = job({ status: "running" });
    jobs.activeByKey.set("publish:project-1", active);

    await expect(service.start(START)).resolves.toEqual({
      outcome: "already_active",
      job: active,
    });
    expect(admission.calls).toEqual([]);
  });

  test("reports already_active when admission returns an active job", async () => {
    const active = job({ status: "running" });
    const { service, dispatcher } = setup({
      admission: async () => ({ outcome: "already_active", job: active }),
    });

    await expect(service.start(START)).resolves.toEqual({
      outcome: "already_active",
      job: active,
    });
    expect(dispatcher.messages).toEqual([]);
  });

  test("reports active_conflict when admission loses the race", async () => {
    const { service, dispatcher } = setup({
      admission: async () => {
        throw new ActiveGenerationConflictError();
      },
    });

    await expect(service.start(START)).resolves.toEqual({
      outcome: "active_conflict",
    });
    expect(dispatcher.messages).toEqual([]);
  });

  test("rethrows unexpected admission errors", async () => {
    const { service } = setup({
      admission: async () => {
        throw new Error("GitHub unavailable");
      },
    });

    await expect(service.start(START)).rejects.toThrow("GitHub unavailable");
  });

  test("reports confirmation_required for an unchanged source", async () => {
    const { service, dispatcher } = setup({
      admission: async () => ({
        outcome: "confirmation_required",
        reason: "unchanged_source",
        message: "Nothing changed.",
      }),
    });

    await expect(service.start(START)).resolves.toEqual({
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message: "Nothing changed.",
    });
    expect(dispatcher.messages).toEqual([]);
  });

  test("dispatches the admitted job and reports started", async () => {
    const { service, admission, dispatcher } = setup();

    await expect(service.start({ ...START, force: true })).resolves.toEqual({
      outcome: "started",
      job: job({ status: "queued" }),
    });
    expect(admission.calls).toEqual([
      { userId: "user-1", projectId: "project-1", force: true },
    ]);
    expect(dispatcher.messages).toEqual([
      { jobId: "job-1", projectId: "project-1", userId: "user-1" },
    ]);
  });

  test("reports the job returned by a synchronous dispatcher", async () => {
    const finished = job({ status: "succeeded" });
    const { service } = setup({
      dispatchResult: { status: "dispatched", job: finished },
    });

    await expect(service.start(START)).resolves.toEqual({
      outcome: "started",
      job: finished,
    });
  });

  test("marks the job failed and reports dispatch_failed", async () => {
    const { service, jobs } = setup({
      dispatchResult: { status: "failed", message: "Boom." },
    });

    await expect(service.start(START)).resolves.toEqual({
      outcome: "dispatch_failed",
      message: "Boom.",
    });
    expect(jobs.failed).toEqual([{ jobId: "job-1", message: "Boom." }]);
  });
});

describe("generation dispatchers", () => {
  const message: GenerateJobMessage = {
    jobId: "job-1",
    projectId: "project-1",
    userId: "user-1",
  };

  test("container-inline defers the run and swallows its failure", async () => {
    const deferred: Array<Promise<unknown>> = [];
    const runs: unknown[] = [];
    const dispatcher = new ContainerInlineGenerationDispatcher({
      run: async (input) => {
        runs.push(input);
        throw new Error("container down");
      },
      defer: (promise) => deferred.push(promise),
    });

    await expect(dispatcher.dispatch(message)).resolves.toEqual({
      status: "dispatched",
      job: null,
    });
    expect(deferred).toHaveLength(1);
    await expect(Promise.all(deferred)).resolves.toEqual([undefined]);
    expect(runs).toEqual([{ jobId: "job-1", projectId: "project-1" }]);
  });

  test("starter-dev returns the refreshed job", async () => {
    const refreshed = job({ status: "succeeded" });
    const dispatcher = new StarterDevGenerationDispatcher({
      publish: async () => undefined,
      jobs: { getForUser: async () => refreshed },
    });

    await expect(dispatcher.dispatch(message)).resolves.toEqual({
      status: "dispatched",
      job: refreshed,
    });
  });

  test("starter-dev reports a publish failure", async () => {
    const dispatcher = new StarterDevGenerationDispatcher({
      publish: async () => {
        throw new Error("R2 down");
      },
      jobs: { getForUser: async () => null },
    });

    await expect(dispatcher.dispatch(message)).resolves.toEqual({
      status: "failed",
      message: "R2 down",
    });
  });

  test("an unsupported mode reports failure", async () => {
    await expect(
      new UnsupportedModeGenerationDispatcher("mystery").dispatch(),
    ).resolves.toEqual({
      status: "failed",
      message: "Unsupported generation mode: mystery.",
    });
  });
});

function project(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: "project-1",
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

function job(overrides: Partial<GenerationJobDto> = {}): GenerationJobDto {
  return {
    id: "job-1",
    projectId: "project-1",
    status: "queued",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

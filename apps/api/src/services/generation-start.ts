import type { ProductionGenerationTrigger } from "../repositories/jobs";
import type {
  GenerationConfirmationReason,
  GenerateJobMessage,
  GenerationJobDto,
  ProjectDto,
} from "@doxahq/contracts";
import type { Env } from "../env";
import type { BillingRefusal } from "./billing/generation-metering";
import type { GenerationStartedBy } from "./generation-analytics";
import {
  findProjectRepositoryIssue,
  type RepositoryConnectionIssue,
} from "../repositories/github-lifecycle";
import type { RepositoryTooLarge } from "./repository-size";
import {
  ActiveGenerationConflictError,
  JobsRepository,
  productionConcurrencyKey,
} from "../repositories/jobs";
import { ProjectsRepository } from "../repositories/projects";
import {
  createGenerationDispatcher,
  type Defer,
  type GenerationDispatcher,
} from "./generation-dispatch";
import {
  ProductionGenerationAdmissionService,
  type ProductionGenerationAdmission,
} from "./production-generation-admission";

export interface GenerationStartInput {
  userId: string;
  projectId: string;
  force: boolean;
  /** Start a first generation from the pages written in the editor. */
  seed?: boolean;
  /** Who starts the run: a person, or Doxabot after merges. */
  trigger?: ProductionGenerationTrigger;
  /** The person and the surface that started the run (product analytics). Absent for a merge run. */
  startedBy?: GenerationStartedBy;
}

export type GenerationStartOutcome =
  | { outcome: "not_found" }
  /**
   * No repository, or GitHub took it away (`reason`): the app lost it, or the
   * installation is suspended or uninstalled. The site stays live.
   */
  | { outcome: "repository_required"; reason?: RepositoryConnectionIssue }
  | { outcome: "paused" }
  | { outcome: "already_active"; job: GenerationJobDto }
  /** Admission lost a race and the blocking job is already gone. */
  | { outcome: "active_conflict" }
  | {
      outcome: "confirmation_required";
      reason: GenerationConfirmationReason;
      message: string;
    }
  | { outcome: "started"; job: GenerationJobDto }
  | { outcome: "dispatch_failed"; message: string }
  /** Billing refused the run (spec 10.6): no job was created. */
  | { outcome: "billing_refused"; error: BillingRefusal }
  /** The repository is above the size limit: no job was created. */
  | RepositoryTooLarge;

export interface GenerationStartProjectsStore {
  getForUser(userId: string, projectId: string): Promise<ProjectDto | null>;
}

export interface GenerationStartJobsStore {
  isGenerationPaused(): Promise<boolean>;
  activeForConcurrencyKey(
    concurrencyKey: string,
  ): Promise<GenerationJobDto | null>;
  markFailed(jobId: string, message: string): Promise<unknown>;
}

export interface GenerationAdmission {
  admit(input: GenerationStartInput): Promise<ProductionGenerationAdmission>;
}

export interface GenerationStartServiceDependencies {
  projects: GenerationStartProjectsStore;
  /** Absent: the repository is taken as usable. */
  repositoryIssue?: (projectId: string) => Promise<RepositoryConnectionIssue | null>;
  jobs: GenerationStartJobsStore;
  admission: GenerationAdmission;
  dispatcher: GenerationDispatcher;
}

type AdmissionResult =
  | ProductionGenerationAdmission
  | { outcome: "active_conflict" };

export class GenerationStartService {
  constructor(private readonly deps: GenerationStartServiceDependencies) {}

  static fromEnv(env: Env, options: { defer: Defer }): GenerationStartService {
    const jobs = new JobsRepository(env);
    return new GenerationStartService({
      projects: new ProjectsRepository(env),
      repositoryIssue: (projectId) => findProjectRepositoryIssue(env, projectId),
      jobs,
      // Built on first use: its GitHub source and baselines store are only
      // needed once the cheap checks pass.
      admission: {
        admit: (input) =>
          ProductionGenerationAdmissionService.fromEnv(env, jobs).admit(input),
      },
      dispatcher: createGenerationDispatcher(env, options.defer, jobs),
    });
  }

  async start(input: GenerationStartInput): Promise<GenerationStartOutcome> {
    const project = await this.deps.projects.getForUser(
      input.userId,
      input.projectId,
    );
    if (!project) return { outcome: "not_found" };
    if (!project.githubRepositoryId) return { outcome: "repository_required" };
    const repositoryIssue = await this.deps.repositoryIssue?.(project.id);
    if (repositoryIssue) return { outcome: "repository_required", reason: repositoryIssue };
    if (await this.deps.jobs.isGenerationPaused()) return { outcome: "paused" };

    const activeJob = await this.deps.jobs.activeForConcurrencyKey(
      productionConcurrencyKey(project.id),
    );
    if (activeJob) return { outcome: "already_active", job: activeJob };

    const admission = await this.admit({ ...input, projectId: project.id });
    if (admission.outcome !== "created") return admission;

    return this.dispatch({
      jobId: admission.job.id,
      projectId: project.id,
      userId: input.userId,
    }, admission.job);
  }

  private async admit(input: GenerationStartInput): Promise<AdmissionResult> {
    try {
      return await this.deps.admission.admit(input);
    } catch (err) {
      if (err instanceof ActiveGenerationConflictError) {
        return { outcome: "active_conflict" };
      }
      throw err;
    }
  }

  private async dispatch(
    message: GenerateJobMessage,
    job: GenerationJobDto,
  ): Promise<GenerationStartOutcome> {
    const result = await this.deps.dispatcher.dispatch(message);
    if (result.status === "failed") {
      await this.deps.jobs.markFailed(job.id, result.message);
      return { outcome: "dispatch_failed", message: result.message };
    }
    return { outcome: "started", job: result.job ?? job };
  }
}

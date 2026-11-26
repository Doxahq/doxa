import type {
  GenerationActionBlockedReason,
  NormalizedReviewRunRetryEvent,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import {
  DoxabotSettingsRepository,
  type DoxabotAutomationContext,
  type DoxabotSettingsStore,
} from "../../repositories/doxabot-settings";
import { PREVIEW_RETRY_EVENT_TYPES } from "../../repositories/job-events";
import { JobsRepository, type ReviewRunJobsStore } from "../../repositories/jobs";
import type { Defer } from "../generation-dispatch";
import {
  GenerationRerunService,
  type GenerationRerunOutcome,
} from "../generation-rerun";
import {
  GitHubRepositoryPermissions,
  type RepositoryWriteAccess,
} from "./github-repository-permissions";

/** Why a retry from the pull request check did not start a run. */
export type PreviewRetryRefusal =
  /** No project has the repository, or GitHub took the repository away. */
  | "project_not_found"
  | "repository_unavailable"
  /** The check is not the check of a preview job of this project. */
  | "check_not_found"
  /** The person cannot push to the repository. */
  | "not_permitted"
  /** GitHub did not answer the permission check. */
  | "permission_unknown"
  | Exclude<GenerationRerunOutcome["outcome"], "started" | "blocked">
  | GenerationActionBlockedReason;

export type PreviewRetryOutcome =
  | { outcome: "started"; jobId: string }
  | { outcome: "refused"; reason: PreviewRetryRefusal };

interface PreviewRetryEvents {
  addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface PreviewRetryDependencies {
  settings: Pick<DoxabotSettingsStore, "getAutomationContext">;
  checks: Pick<ReviewRunJobsStore, "getReviewRunContext">;
  events: PreviewRetryEvents;
  permissions: RepositoryWriteAccess;
  reruns: Pick<GenerationRerunService, "rerun">;
}

/**
 * Runs a preview again when a person presses "Re-run" or "Retry preview" on
 * its pull request check. Only a person who can push to the repository may:
 * the run costs the project owner's credits, like a push does. The run
 * starts like the dashboard's re-run, on the pull request's head.
 */
export class PreviewCheckRetryService {
  constructor(private readonly deps: PreviewRetryDependencies) {}

  static fromEnv(env: Env, options: { defer: Defer }): PreviewCheckRetryService {
    const jobs = new JobsRepository(env);
    return new PreviewCheckRetryService({
      settings: new DoxabotSettingsRepository(env),
      checks: jobs,
      events: jobs,
      permissions: GitHubRepositoryPermissions.fromEnv(env),
      reruns: GenerationRerunService.fromEnv(env, options),
    });
  }

  async retry(event: NormalizedReviewRunRetryEvent): Promise<PreviewRetryOutcome> {
    const context = await this.deps.settings.getAutomationContext({
      provider: event.repository.provider,
      repositoryExternalId: event.repository.externalId,
      installationExternalId: event.repository.installationExternalId,
    });
    if (!context) return refused("project_not_found");
    if (context.connectionIssue) return refused("repository_unavailable");
    if (!(await this.isCheckOfProject(event, context))) return refused("check_not_found");

    const login = event.requestedBy.login;
    await this.record(event.jobId, PREVIEW_RETRY_EVENT_TYPES.requested, `@${login} asked to run this preview again.`, {
      login,
      trigger: event.trigger,
    });

    const permission = await this.checkPermission(context, login);
    if (permission !== null) return this.refuse(event, permission);

    const result = await this.deps.reruns.rerun({
      userId: context.ownerUserId,
      projectId: context.projectId,
      jobId: event.jobId,
      // The person pressed the button, so a run that worked runs again too.
      force: true,
    });
    if (result.outcome === "started") return { outcome: "started", jobId: result.job.id };
    return this.refuse(event, result.outcome === "blocked" ? result.reason : result.outcome);
  }

  /** The check must be the stored check of a preview job of this project. */
  private async isCheckOfProject(
    event: NormalizedReviewRunRetryEvent,
    context: DoxabotAutomationContext,
  ): Promise<boolean> {
    const check = await this.deps.checks.getReviewRunContext(event.jobId);
    return (
      check !== null &&
      check.projectId === context.projectId &&
      check.externalReviewRunId === event.externalRunId &&
      check.repository.externalId === event.repository.externalId
    );
  }

  /** Null when the person may run the preview; otherwise why not. */
  private async checkPermission(
    context: DoxabotAutomationContext,
    login: string,
  ): Promise<"not_permitted" | "permission_unknown" | null> {
    try {
      const allowed = await this.deps.permissions.canWrite({
        repositoryOwner: context.repositoryOwner,
        repositoryName: context.repositoryName,
        repositoryExternalId: context.repositoryExternalId,
        installationExternalId: context.installationExternalId,
        login,
      });
      return allowed ? null : "not_permitted";
    } catch {
      return "permission_unknown";
    }
  }

  private async refuse(
    event: NormalizedReviewRunRetryEvent,
    reason: PreviewRetryRefusal,
  ): Promise<PreviewRetryOutcome> {
    await this.record(event.jobId, PREVIEW_RETRY_EVENT_TYPES.refused, "Doxabot did not run this preview again.", {
      login: event.requestedBy.login,
      reason,
    });
    return refused(reason);
  }

  /** The event only informs; a failed write must not change the outcome. */
  private async record(
    jobId: string,
    type: string,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.events.addEvent(jobId, type, message, data).catch(() => undefined);
  }
}

function refused(reason: PreviewRetryRefusal): PreviewRetryOutcome {
  return { outcome: "refused", reason };
}

import {
  ACTIVE_GENERATION_MESSAGE,
  REPOSITORY_REQUIRED_MESSAGE,
  connectProjectRepositoryInputSchema,
  createExampleProjectInputSchema,
  createProjectInputSchema,
  updateDocsPreviewVisibilityInputSchema,
  type GenerationActionBlockedReason,
  type GenerationJobDto,
  type GenerationStartResultDto,
} from "@doxahq/contracts";
import { createApiRouter } from "../http/app";
import type { ApiApp } from "../http/app";
import { withUser } from "../http/auth";
import { streamEvents } from "../http/progress-stream";
import { forbidden, withProjectAccess } from "../http/project-access";
import { parseValidatedJson } from "../http/validation";
import { error, json, notFound } from "../http/response";
import { JobsRepository } from "../repositories/jobs";
import { GenerationCacheRepository } from "../repositories/generation-cache";
import { PreviewVisibilityRepository } from "../repositories/preview-visibility";
import {
  CreateProjectError,
  ProjectsRepository,
} from "../repositories/projects";
import { cancelGenerationJob } from "../services/generation-cancellation";
import { createExampleProject } from "../services/example-docs/create-project";
import { ProjectDeletionError } from "../repositories/project-deletion";
import {
  DocsDomainProvisioningError,
  getDocsDomainProvisioningStatus,
} from "../services/docs-domain-lifecycle";
import { deleteProject } from "../services/project-deletion";
import {
  GenerationStartService,
  type GenerationStartOutcome,
} from "../services/generation-start";
import { GenerationRerunService } from "../services/generation-rerun";
import { GenerationResumeService } from "../services/generation-resume";
import {
  isTrustedGenerationStreamOrigin,
  parseGenerationStreamCursor,
  streamGenerationEvents,
} from "../services/generation-event-stream";
import { parseGenerationPageRequest } from "../utils/generation-pagination";
import { createDocsContentRoutes } from "./docs-content";
import { createDocsBranchRoutes } from "./docs-branches";
import { createGenerationReviewRoutes } from "./generation-reviews";
import { createGenerationChangesRoutes } from "./generation-changes";
import { createPageLockRoutes } from "./page-locks";
import { createDocsHistoryRoutes } from "./docs-history";
import { createSiteAssetsRoutes } from "./site-assets";
import { createDocsDomainRoutes } from "./docs-domains";
import { createProjectApprovalRequestRoutes } from "./approval-requests";
import { createProjectApprovalSettingsRoutes } from "./approval-settings";
import { createDoxabotRoutes } from "./doxabot";
import { createProjectTeamRoutes } from "./teams";
import { handleProjectShell } from "./project-shell";
import { listGenerationsPage, readProjectDetail } from "./project-reads";
import { dashboardActor } from "../services/agent-access/actor";
import { MembershipProjectAccessPolicy } from "../services/agent-access/membership-project-access-policy";
import { toGenerationLog } from "../services/generation-log";
import {
  withDocsUrl,
  withPreferredDocsUrls,
} from "../utils/project-docs-urls";

export function createProjectRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withUser(context, async (userId) => {
      // Personal projects and the projects of the user's teams (spec §5).
      const projects = await MembershipProjectAccessPolicy.fromEnv(
        context.env,
      ).listAccessibleProjects(dashboardActor(userId));
      return json({
        projects: await withPreferredDocsUrls(projects, context.env),
      });
    }),
  );

  app.post("/", (context) =>
    withUser(context, async (userId) => {
      const input = await parseValidatedJson(
        context,
        createProjectInputSchema,
        "Invalid project payload.",
      );
      if (!input.ok) return input.response;

      try {
        const project = await new ProjectsRepository(
          context.env,
        ).createForRepository({
          userId,
          ...input.data,
        });

        return json(
          { project: withDocsUrl(project, context.env) },
          { status: 201 },
        );
      } catch (err) {
        if (err instanceof CreateProjectError) {
          return error(err.message, getCreateProjectStatus(err));
        }

        throw err;
      }
    }),
  );

  app.post("/example", (context) =>
    withUser(context, async (userId) => {
      const input = await parseValidatedJson(
        context,
        createExampleProjectInputSchema,
        "Invalid project payload.",
      );
      if (!input.ok) return input.response;

      try {
        const project = await createExampleProject(context.env, {
          userId,
          ...input.data,
        });
        return json(
          { project: withDocsUrl(project, context.env) },
          { status: 201 },
        );
      } catch (err) {
        if (err instanceof CreateProjectError) {
          return error(err.message, getCreateProjectStatus(err));
        }

        throw err;
      }
    }),
  );

  app.put("/:projectId/repository", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      // The repository comes from the owner's GitHub installation, so only
      // the owner can pick it.
      if (access.actorUserId !== access.ownerUserId) {
        return forbidden("Only the project owner can connect a repository.");
      }
      const userId = access.ownerUserId;
      const input = await parseValidatedJson(
        context,
        connectProjectRepositoryInputSchema,
        "Invalid repository payload.",
      );
      if (!input.ok) return input.response;

      try {
        const project = await new ProjectsRepository(
          context.env,
        ).connectRepository({
          userId,
          projectId: context.req.param("projectId"),
          githubRepositoryId: input.data.githubRepositoryId,
        });
        return json({ project: withDocsUrl(project, context.env) });
      } catch (err) {
        if (err instanceof CreateProjectError) {
          return error(err.message, getCreateProjectStatus(err));
        }

        throw err;
      }
    }),
  );

  app.post("/:projectId/generate", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      // The owner pays for the generation and owns the GitHub installation.
      const outcome = await GenerationStartService.fromEnv(context.env, {
        defer: (promise) => context.executionCtx.waitUntil(promise),
      }).start({
        userId: access.ownerUserId,
        projectId: access.projectId,
        force: new URL(context.req.url).searchParams.get("force") === "true",
        seed: new URL(context.req.url).searchParams.get("seed") === "true",
      });
      return generationStartOutcomeResponse(outcome);
    }),
  );

  app.route("/:projectId/content", createDocsContentRoutes());
  app.route("/:projectId/branches", createDocsBranchRoutes());
  app.route("/:projectId/generation-review", createGenerationReviewRoutes());
  app.route("/:projectId/generations", createGenerationChangesRoutes());
  app.route("/:projectId/page-locks", createPageLockRoutes());
  app.route("/:projectId/history", createDocsHistoryRoutes());
  app.route("/:projectId/assets", createSiteAssetsRoutes());
  app.route("/:projectId/docs-domains", createDocsDomainRoutes());
  app.route("/:projectId/doxabot", createDoxabotRoutes());
  app.route("/:projectId/approval-requests", createProjectApprovalRequestRoutes());
  app.route("/:projectId/approval-settings", createProjectApprovalSettingsRoutes());
  app.route("/:projectId/team", createProjectTeamRoutes());

  app.get("/:projectId/generations", (context) =>
    withProjectAccess(context, "generation.read", async (access) => {
      const pagination = parseGenerationPageRequest(new URL(context.req.url));
      if (!pagination.ok) return error(pagination.message, 400);
      return listGenerationsPage(context, access, pagination.value);
    }),
  );

  app.get("/:projectId/generations/:generationId/events", (context) =>
    withProjectAccess(context, "generation.read", async ({ ownerUserId: userId }) => {
      const jobs = new JobsRepository(context.env);
      const generation = await jobs.getForProject({
        userId,
        projectId: context.req.param("projectId"),
        jobId: context.req.param("generationId"),
      });
      if (!generation) return notFound();

      const events = await jobs.listEvents(generation.id);
      return json({ events: toGenerationLog(events) });
    }),
  );

  app.get("/:projectId/generations/:generationId/stream", (context) => {
    if (!isTrustedGenerationStreamOrigin(context.req.raw, context.env)) {
      return error("Untrusted stream origin.", 403);
    }

    const initialSequence = parseGenerationStreamCursor(context.req.raw);
    if (initialSequence === null) {
      return error("Invalid generation event cursor.", 400);
    }

    return withProjectAccess(context, "generation.read", async ({ ownerUserId: userId }) => {
      const jobs = new JobsRepository(context.env);
      const initialState = await jobs.getStreamStateForProject({
        userId,
        projectId: context.req.param("projectId"),
        jobId: context.req.param("generationId"),
      });
      if (!initialState) return notFound();

      const generation = initialState.generation;

      const response = streamEvents(context, async (stream) => {
        try {
          await streamGenerationEvents({
            stream,
            jobs,
            userId,
            initialState,
            initialSequence,
            env: context.env,
          });
        } catch (streamError) {
          console.error("Generation event stream failed.", {
            generationId: generation.id,
            message:
              streamError instanceof Error
                ? streamError.message
                : "Unknown stream error.",
          });

          if (!stream.aborted) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                message: "Generation stream interrupted.",
              }),
            });
          }
        }
      });

      context.res = response;
      context.header("Cache-Control", "no-store, no-transform");
      context.header("Content-Encoding", "Identity");
      context.header("X-Accel-Buffering", "no");
      return context.res;
    });
  });

  app.post("/:projectId/generations/:generationId/cancel", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      const { projectId, ownerUserId: userId } = access;
      const generationId = context.req.param("generationId");
      const jobs = new JobsRepository(context.env);
      const generation = await jobs.getForProject({
        userId,
        projectId,
        jobId: generationId,
      });
      if (!generation) return notFound();

      const result = await cancelGenerationJob(context.env, jobs, {
        jobId: generation.id,
        message: "Cancelled by user.",
        eventType: "user_cancel_requested",
        data: { requestedByUserId: access.actorUserId },
      });
      if (!result.transitioned) {
        return error("Generation has already finished.", 409);
      }

      const cancelled = await jobs.getDetailForProject({
        userId,
        projectId,
        jobId: generation.id,
      });
      if (!cancelled) return notFound();

      return json({ generation: cancelled });
    }),
  );

  app.post("/:projectId/generations/:generationId/rerun", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      // The owner pays for the generation and owns the GitHub installation.
      const outcome = await GenerationRerunService.fromEnv(context.env, {
        defer: (promise) => context.executionCtx.waitUntil(promise),
      }).rerun({
        userId: access.ownerUserId,
        projectId: access.projectId,
        jobId: context.req.param("generationId"),
        force: new URL(context.req.url).searchParams.get("force") === "true",
        seed: new URL(context.req.url).searchParams.get("seed") === "true",
      });
      if (outcome.outcome === "blocked") {
        return error(RERUN_BLOCKED_MESSAGES[outcome.reason] ?? RERUN_BLOCKED_FALLBACK, 409, {
          code: outcome.reason,
        });
      }
      return generationStartOutcomeResponse(outcome);
    }),
  );

  app.post("/:projectId/generations/:generationId/resume", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      const jobId = context.req.param("generationId");
      const outcome = await GenerationResumeService.fromEnv(context.env).resume({
        userId: access.ownerUserId,
        projectId: access.projectId,
        jobId,
      });
      if (outcome.outcome === "not_found") return notFound();
      if (outcome.outcome === "blocked") {
        return error(RESUME_BLOCKED_MESSAGES[outcome.reason] ?? RESUME_BLOCKED_FALLBACK, 409, {
          code: outcome.reason,
        });
      }
      const generation = await new JobsRepository(context.env).getDetailForProject({
        userId: access.ownerUserId,
        projectId: access.projectId,
        jobId,
      });
      return generation ? json({ generation }) : notFound();
    }),
  );

  app.get("/:projectId/generations/:generationId", (context) =>
    withProjectAccess(context, "generation.read", async ({ ownerUserId: userId }) => {
      const generation = await new JobsRepository(
        context.env,
      ).getDetailForProject({
        userId,
        projectId: context.req.param("projectId"),
        jobId: context.req.param("generationId"),
      });
      if (!generation) return notFound();

      return json({ generation });
    }),
  );

  app.post("/:projectId/generations/:generationId/promote", (context) =>
    // Promoting a generation makes it the live docs: a publish.
    withProjectAccess(context, "docs.publish", async (access) => {
      const { projectId, ownerUserId: userId } = access;
      const jobId = context.req.param("generationId");
      const jobs = new JobsRepository(context.env);
      const result = await jobs.promoteForProject({
        userId,
        projectId,
        jobId,
      });
      if (result.outcome === "not_found") return notFound();
      if (result.outcome === "blocked") {
        return json({ error: result.reason }, { status: 409 });
      }

      const generation = await jobs.getDetailForProject({
        userId,
        projectId,
        jobId,
      });
      if (!generation) return notFound();
      return json({
        generation,
        publishedVersionId: result.publishedVersionId,
      });
    }),
  );

  app.delete("/:projectId/generations/:generationId", (context) =>
    withProjectAccess(context, "generation.run", async ({ ownerUserId: userId }) => {
      const result = await new JobsRepository(context.env).deleteForProject({
        userId,
        projectId: context.req.param("projectId"),
        jobId: context.req.param("generationId"),
      });
      if (result.outcome === "not_found") return notFound();
      if (result.outcome === "blocked") {
        return json({ error: result.reason }, { status: 409 });
      }
      return new Response(null, { status: 204 });
    }),
  );

  app.get("/:projectId/generation-cache", (context) =>
    withProjectAccess(context, "generation.read", async (access) => {
      const { projectId, ownerUserId: userId } = access;
      const project = await new ProjectsRepository(context.env).getForUser(
        userId,
        projectId,
      );
      if (!project) return notFound();

      const cache = await new GenerationCacheRepository(
        context.env,
      ).getForProject(project.id);
      if (!cache) return notFound();

      return json({ generationCache: cache });
    }),
  );

  app.post("/:projectId/generation-cache/clear", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      const { projectId, ownerUserId: userId } = access;
      const project = await new ProjectsRepository(context.env).getForUser(
        userId,
        projectId,
      );
      if (!project) return notFound();

      const activeJob = await new JobsRepository(context.env).latestForProject(
        project.id,
      );
      if (
        activeJob &&
        (activeJob.status === "queued" || activeJob.status === "running")
      ) {
        return error(
          "Finish or cancel the running generation before clearing the cache.",
          409,
        );
      }

      const cache = await new GenerationCacheRepository(
        context.env,
      ).clearForProject(project.id);
      if (!cache) return notFound();

      return json({ generationCache: cache });
    }),
  );

  app.get("/:projectId/preview-visibility", (context) =>
    withProjectAccess(context, "project.read", async (access) => {
      const setting = await new PreviewVisibilityRepository(
        context.env,
      ).getForProject({
        projectId: access.projectId,
        userId: access.ownerUserId,
      });
      if (!setting) return notFound();

      return json(setting);
    }),
  );

  app.put("/:projectId/preview-visibility", (context) =>
    withProjectAccess(context, "site.write", async (access) => {
      const input = await parseValidatedJson(
        context,
        updateDocsPreviewVisibilityInputSchema,
        "Invalid preview visibility payload.",
      );
      if (!input.ok) return input.response;

      const setting = await new PreviewVisibilityRepository(
        context.env,
      ).updateForProject({
        projectId: access.projectId,
        userId: access.ownerUserId,
        previewVisibility: input.data.previewVisibility,
      });
      if (!setting) return notFound();

      return json(setting);
    }),
  );

  app.get("/:projectId/shell", (context) => handleProjectShell(context));

  app.get("/:projectId", (context) =>
    withProjectAccess(context, "project.read", (access) =>
      readProjectDetail(context, access),
    ),
  );

  app.delete("/:projectId", (context) =>
    withProjectAccess(context, "project.delete", async (access) => {
      try {
        await deleteProject(context.env, {
          userId: access.ownerUserId,
          projectId: access.projectId,
        });
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof ProjectDeletionError) {
          if (err.code === "project_not_found") return notFound();
          return error(err.message, 409, { code: err.code });
        }
        if (err instanceof DocsDomainProvisioningError) {
          return error(err.message, getDocsDomainProvisioningStatus(err));
        }
        throw err;
      }
    }),
  );

  return app;
}

function generationStartResponse(
  job: GenerationJobDto,
  outcome: "started" | "already_active",
): Response {
  const result: GenerationStartResultDto =
    outcome === "already_active"
      ? { job, outcome, message: ACTIVE_GENERATION_MESSAGE }
      : { job, outcome, message: null };
  return json(result, { status: 202 });
}

const RERUN_BLOCKED_FALLBACK = "This generation cannot run again.";

const RESUME_BLOCKED_FALLBACK =
  "This generation cannot continue from where it stopped. Re-run it instead.";

const RESUME_BLOCKED_MESSAGES: Partial<Record<GenerationActionBlockedReason, string>> = {
  in_progress: "Another generation of this project is running. Continue this one after it ends.",
  superseded: "A newer run for this pull request replaced this generation.",
  change_not_open: "The pull request is closed, merged, or a draft.",
};

const RERUN_BLOCKED_MESSAGES: Partial<Record<GenerationActionBlockedReason, string>> = {
  not_finished: "A generation runs again only after it ends.",
  superseded: "A newer run for this pull request replaced this generation.",
  change_not_open: "The pull request is closed, merged, or a draft.",
  previews_unavailable: "Pull request previews are not available for this project.",
};

function generationStartOutcomeResponse(
  outcome: GenerationStartOutcome,
): Response {
  switch (outcome.outcome) {
    case "not_found":
      return notFound();
    case "repository_required":
      return error(REPOSITORY_REQUIRED_MESSAGE, 409, {
        code: "repository_required",
      });
    case "paused":
      return error("Generation is currently paused by an administrator.", 409);
    case "active_conflict":
      return error(ACTIVE_GENERATION_MESSAGE, 409);
    case "already_active":
    case "started":
      return generationStartResponse(outcome.job, outcome.outcome);
    case "confirmation_required": {
      const result: GenerationStartResultDto = { job: null, ...outcome };
      return json(result);
    }
    case "dispatch_failed":
      return error(outcome.message, 500);
  }
}

function getCreateProjectStatus(error: CreateProjectError): number {
  switch (error.code) {
    case "repository_not_found":
    case "project_not_found":
      return 404;
    case "repository_project_exists":
    case "repository_already_connected":
    case "slug_unavailable":
      return 409;
  }
}

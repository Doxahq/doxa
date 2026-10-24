import { z } from "zod";
import { createApiRouter } from "../http/app";
import type { ApiApp, ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { json, notFound } from "../http/response";
import { JobsRepository } from "../repositories/jobs";
import { dashboardActor } from "../services/agent-access/actor";
import { MembershipProjectAccessPolicy } from "../services/agent-access/membership-project-access-policy";
import { toGenerationLog } from "../services/generation-log";
import type { GenerationJobDto } from "@doxahq/contracts";

export function createJobRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/:jobId", (context) =>
    withUser(context, async (userId) => {
      const job = await findVisibleJob(context, userId);
      if (!job) return notFound();
      return json({ job });
    }),
  );

  app.get("/:jobId/events", (context) =>
    withUser(context, async (userId) => {
      const job = await findVisibleJob(context, userId);
      if (!job) return notFound();
      const events = await new JobsRepository(context.env).listEvents(job.id);
      return json({ events: toGenerationLog(events) });
    }),
  );

  return app;
}

/**
 * A generation is visible to anyone who can read generations of its project
 * (v2 spec §5). The lookup goes through the access policy, so a team member
 * sees it and anyone else gets "not found".
 */
async function findVisibleJob(
  context: ApiContext,
  userId: string,
): Promise<GenerationJobDto | null> {
  const parsed = z.uuid().safeParse(context.req.param("jobId"));
  if (!parsed.success) return null;
  const jobId = parsed.data;
  const jobs = new JobsRepository(context.env);
  const projectId = await jobs.findProjectId(jobId);
  if (projectId === null) return null;
  const decision = await MembershipProjectAccessPolicy.fromEnv(
    context.env,
  ).authorize(dashboardActor(userId), projectId, "generation.read");
  if (!decision.allowed) return null;
  return jobs.getForUser(decision.project.ownerUserId, jobId);
}

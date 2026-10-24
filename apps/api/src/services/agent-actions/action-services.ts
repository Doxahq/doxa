import type { Env } from "../../env";
import { DocsBranchesRepository, type DocsBranchStore } from "../../repositories/docs-branches";
import { DocsDomainsRepository } from "../../repositories/docs-domains";
import { ProjectDeletionRepository } from "../../repositories/project-deletion";
import { JobsRepository } from "../../repositories/jobs";
import { ProjectsRepository } from "../../repositories/projects";
import { withPreferredDocsUrl } from "../../utils/project-docs-urls";
import { DocsBranchHistory } from "../docs-branches/history";
import { DocsBranchPublish } from "../docs-branches/publish";
import { branchMdxIssues } from "../docs-content/page-mdx-issues";
import { DocsDomainLifecycleService } from "../docs-domain-lifecycle";
import { createExampleProject } from "../example-docs/create-project";
import type { Defer } from "../generation-dispatch";
import { cancelGenerationJob } from "../generation-cancellation";
import { GenerationStartService } from "../generation-start";
import { deleteProject } from "../project-deletion";
import type {
  ActionServices,
  DocsPublishPort,
  DomainsPort,
  GenerationCancelOutcome,
  ProjectsPort,
  PublishBranchState,
} from "./action-ports";

/** The only place that binds the side-effect services of actions to the env. */
export function actionServicesFromEnv(env: Env, options: { defer: Defer }): ActionServices {
  const projects = new ProjectsRepository(env);
  return {
    publish: publishPort(env),
    liveSite: {
      async liveUrl(input) {
        const project = await projects.getForUser(input.userId, input.projectId);
        return project ? (await withPreferredDocsUrl(project, env)).docsUrl : null;
      },
    },
    restore: {
      async mainVersionId(input) {
        const site = await new DocsBranchesRepository(env).getSiteForUser(input);
        return site?.mainVersionId ?? null;
      },
      restore: (input) => DocsBranchHistory.fromEnv(env).restore(input),
    },
    domains: domainsPort(env),
    projects: projectsPort(env, projects),
    generation: {
      hasActiveGeneration: (projectId) => new ProjectDeletionRepository(env).hasActiveGeneration(projectId),
      start: (input) => GenerationStartService.fromEnv(env, options).start(input),
      cancel: (input) => cancelGeneration(env, input),
    },
  };
}

function publishPort(env: Env): DocsPublishPort {
  const branches = new DocsBranchesRepository(env);
  return {
    readBranch: (input) => readPublishBranchState(branches, input),
    mdxIssues: async (input) =>
      branchMdxIssues(
        await branches.listChanges({
          userId: input.userId,
          projectId: input.projectId,
          branch: input.branchId,
        }),
      ),
    publish: (input) =>
      DocsBranchPublish.fromEnv(env).publish({
        userId: input.userId,
        projectId: input.projectId,
        branch: input.branchId,
        request: input.request,
        attribution: input.attribution,
        onStage: input.onStage,
      }),
  };
}

/** Agents publish named branches only; anything else reads as "gone". */
export async function readPublishBranchState(
  branches: Pick<DocsBranchStore, "resolveForUser" | "listChanges">,
  input: { userId: string; projectId: string; branchId: string },
): Promise<PublishBranchState | null> {
  const scoped = { userId: input.userId, projectId: input.projectId, branch: input.branchId };
  const context = await branches.resolveForUser(scoped);
  if (!context?.branch || context.branch.kind !== "named") return null;
  const changes = await branches.listChanges(scoped);
  return {
    branchId: context.branch.id,
    branchName: context.branch.name,
    revision: context.branch.revision,
    baseVersionId: context.branch.baseVersionId,
    mainVersionId: context.site.mainVersionId,
    changeCount: changes.length,
  };
}

function domainsPort(env: Env): DomainsPort {
  const lifecycle = () => new DocsDomainLifecycleService(env);
  return {
    async find(input) {
      const domain = await new DocsDomainsRepository(env).getForProject(input);
      return domain ? { id: domain.id, hostname: domain.hostname, kind: domain.kind } : null;
    },
    create: (input) =>
      lifecycle().createCustomDomain({ ...input, docsBaseDomain: env.DOCS_BASE_DOMAIN }),
    remove: (input) => lifecycle().deleteForProject(input),
    refresh: (input) => lifecycle().refreshForProject(input),
  };
}

function projectsPort(env: Env, projects: ProjectsRepository): ProjectsPort {
  return {
    async find(input) {
      const project = await projects.getForUser(input.userId, input.projectId);
      return project ? { id: project.id, name: project.name } : null;
    },
    createExample: (input) => createExampleProject(env, input),
    createForRepository: (input) => projects.createForRepository(input),
    delete: (input) => deleteProject(env, input),
  };
}

/** The same steps as the dashboard cancel route, for an agent. */
async function cancelGeneration(
  env: Env,
  input: { userId: string; projectId: string; generationId: string },
): Promise<GenerationCancelOutcome> {
  const jobs = new JobsRepository(env);
  const scoped = { userId: input.userId, projectId: input.projectId, jobId: input.generationId };
  const generation = await jobs.getForProject(scoped);
  if (!generation) return { outcome: "not_found" };
  const result = await cancelGenerationJob(env, jobs, {
    jobId: generation.id,
    message: "Cancelled by an agent.",
    eventType: "user_cancel_requested",
    data: { requestedByUserId: input.userId },
  });
  if (!result.transitioned) return { outcome: "already_finished" };
  const cancelled = await jobs.getDetailForProject(scoped);
  return cancelled ? { outcome: "cancelled", generation: cancelled } : { outcome: "not_found" };
}

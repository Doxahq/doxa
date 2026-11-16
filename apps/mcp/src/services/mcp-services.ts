import type {
  DocsDomainCollectionDto,
  GenerationDetailDto,
  GenerationJobDto,
  GitHubRepositoryDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts";
import type {
  CreateDocsBranchInput,
  DocsBranchCreator,
  DocsBranchDiff,
  DocsBranchList,
  DocsBranchPreviewResult,
  DocsBranchStatus,
  DocsPublicationPage,
  DocsSyncPreview,
  NamedDocsBranch,
  SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import type { TeamSummary } from "@doxahq/contracts/teams";
import type { Env } from "@doxahq/api/env";
import type { BranchAgentIdentity } from "@doxahq/api/repositories/docs-branch-management";
import { DocsBranchStatusRepository } from "@doxahq/api/repositories/docs-branch-status";
import { DocsBranchesRepository } from "@doxahq/api/repositories/docs-branches";
import { GitHubRepository } from "@doxahq/api/repositories/github";
import { JobsRepository } from "@doxahq/api/repositories/jobs";
import { ProjectsRepository } from "@doxahq/api/repositories/projects";
import { withPreferredDocsUrls } from "@doxahq/api/utils/project-docs-urls";
import {
  DocsBranchAssetUpload,
  type UploadBranchAssetInput,
  type UploadedBranchAsset,
} from "@doxahq/api/services/docs-branches/assets/asset-upload";
import {
  AgentAssetUploads,
  type AgentAssetTakeResult,
  type AgentAssetUploadRecord,
  type AgentUploadOwner,
  type CreateAgentAssetUploadInput,
} from "@doxahq/api/services/docs-branches/assets/agent-asset-uploads";
import {
  AGENT_ASSET_UPLOAD_AUTH_SCHEME,
  AGENT_ASSET_UPLOAD_PATH,
} from "@doxahq/contracts/docs-assets";
import { DocsBranchDiffService } from "@doxahq/api/services/docs-branches/branch-diff";
import { DocsBranchService } from "@doxahq/api/services/docs-branches/branch-service";
import { DocsBranchHistory } from "@doxahq/api/services/docs-branches/history";
import { DocsBranchPreview } from "@doxahq/api/services/docs-branches/preview";
import { DocsContentService } from "@doxahq/api/services/docs-content/service";
import {
  createR2DocsContentStore,
  withRequestReadCache,
} from "@doxahq/api/services/docs-content/store";
import { DocsDomainLifecycleService } from "@doxahq/api/services/docs-domain-lifecycle";
import { TeamService } from "@doxahq/api/services/teams/team-service";
import { mcpBillingFromEnv, type McpBilling } from "@doxahq/api/services/billing/mcp-billing";
import { DocsSearch, type DocsSearchReader } from "./docs-search";

interface ProjectScopedInput {
  userId: string;
  projectId: string;
}

type BranchScopedInput = ProjectScopedInput & { branch: string };

export interface BranchServices {
  list(input: ProjectScopedInput): Promise<DocsBranchList>;
  getStatus(input: BranchScopedInput): Promise<DocsBranchStatus>;
  create(
    input: ProjectScopedInput & {
      request: CreateDocsBranchInput;
      createdBy: DocsBranchCreator;
    },
  ): Promise<NamedDocsBranch>;
  /**
   * Deletes a branch that this OAuth client created for this member; others
   * are "not found".
   */
  deleteOwn(
    input: ProjectScopedInput & {
      branchId: string;
      agent: BranchAgentIdentity;
    },
  ): Promise<void>;
  diff(input: BranchScopedInput): Promise<DocsBranchDiff>;
  previewSync(input: BranchScopedInput): Promise<DocsSyncPreview>;
  synchronize(
    input: BranchScopedInput & { request: SyncDocsBranchInput },
  ): Promise<{ revision: number; changeCount: number }>;
  buildPreview(input: BranchScopedInput): Promise<DocsBranchPreviewResult>;
  /** Adds an image to a named branch; it goes live with the next publish. */
  uploadAsset(input: UploadBranchAssetInput): Promise<UploadedBranchAsset>;
}

/** An upload URL, and the Authorization value that the PUT must send. */
export interface OpenedAssetUpload {
  uploadId: string;
  uploadUrl: string;
  authorization: string;
  expiresAt: string;
}

/** Upload URLs: the file goes over HTTP, not through the tool call. */
export interface AssetUploadServices {
  create(input: CreateAgentAssetUploadInput): Promise<OpenedAssetUpload>;
  /** Only the connection that created the upload, on its project, gets it. */
  takeFor(uploadId: string, owner: AgentUploadOwner): Promise<AgentAssetTakeResult>;
  /** Deletes the staged keys of the upload and frees its slot. */
  discard(ticket: AgentAssetUploadRecord): Promise<void>;
}

export interface ProjectReader {
  getForUser(userId: string, projectId: string): Promise<ProjectDto | null>;
  latestGeneration(projectId: string): Promise<GenerationJobDto | null>;
  withDocsUrls(projects: ProjectDto[]): Promise<ProjectDto[]>;
}

export interface GenerationReader {
  getDetail(
    input: ProjectScopedInput & { jobId: string },
  ): Promise<GenerationDetailDto | null>;
  listEvents(jobId: string): Promise<JobEventDto[]>;
}

/**
 * Everything the tools call, as narrow interfaces. Production builds it from
 * the request env; tests pass fakes. Writes stop at branch content: publish,
 * restore, domains, and project lifecycle go through agent actions, so a tool
 * cannot reach them through this object.
 */
export interface McpServices {
  readonly projects: ProjectReader;
  readonly github: {
    listRepositories(userId: string): Promise<GitHubRepositoryDto[]>;
  };
  readonly docs: Pick<
    DocsContentService,
    "getOverview" | "getPage" | "applyEdits"
  >;
  readonly search: DocsSearchReader;
  readonly branches: BranchServices;
  readonly assetUploads: AssetUploadServices;
  readonly publications: {
    list(
      input: ProjectScopedInput & { cursor?: string; limit: number },
    ): Promise<DocsPublicationPage>;
  };
  readonly domains: {
    listForProject(
      input: ProjectScopedInput,
    ): Promise<DocsDomainCollectionDto | null>;
  };
  readonly generations: GenerationReader;
  readonly teams: {
    /** The user's teams and roles, for get_account. */
    listForUser(userId: string): Promise<TeamSummary[]>;
  };
  /**
   * Billing spec 11 and 15.3: the daily tool-call quota and the accounts of
   * get_account. Absent in tests that do not need it: no quota, no accounts.
   */
  readonly billing?: Pick<McpBilling, "mode" | "consumeToolCall" | "accountsFor">;
}

export interface McpServiceOptions {
  /** The origin of this Worker, for upload URLs: https://mcp.doxa.so. */
  uploadOrigin: string;
}

/** `env` must be the request-scoped env, so every repository shares one pool. */
export function createMcpServices(
  env: Env,
  options: McpServiceOptions,
): McpServices {
  const branches = new DocsBranchesRepository(env);
  const store = withRequestReadCache(createR2DocsContentStore(env.DOCS_BUCKET));
  const docs = DocsContentService.fromEnv(env);
  const history = DocsBranchHistory.fromEnv(env);
  const domains = new DocsDomainLifecycleService(env);
  // Each method is wrapped so the runtime object holds only the allowed
  // methods, not the service instances with their other methods.
  return {
    projects: createProjectReader(env),
    github: {
      listRepositories: (userId) =>
        new GitHubRepository(env).listReposForUser(userId),
    },
    docs: {
      getOverview: (actor, projectId, branch, options) =>
        docs.getOverview(actor, projectId, branch, options),
      getPage: (actor, projectId, href, branch, options) =>
        docs.getPage(actor, projectId, href, branch, options),
      applyEdits: (actor, projectId, edits, branch, options) =>
        docs.applyEdits(actor, projectId, edits, branch, options),
    },
    search: new DocsSearch(branches, store),
    branches: createBranchServices(env),
    assetUploads: createAssetUploadServices(env, options.uploadOrigin),
    publications: { list: (input) => history.list(input) },
    domains: { listForProject: (input) => domains.listForProject(input) },
    generations: createGenerationReader(env),
    teams: { listForUser: (userId) => TeamService.fromEnv(env).list(userId) },
    billing: createBillingServices(env),
  };
}

function createBillingServices(env: Env): Pick<McpBilling, "mode" | "consumeToolCall" | "accountsFor"> {
  const billing = mcpBillingFromEnv(env);
  return {
    mode: billing.mode,
    consumeToolCall: (projectId) => billing.consumeToolCall(projectId),
    accountsFor: (userId, teams) => billing.accountsFor(userId, teams),
  };
}

function createBranchServices(env: Env): BranchServices {
  const service = DocsBranchService.fromEnv(env);
  return {
    list: (input) => service.list(input),
    getStatus: (input) => new DocsBranchStatusRepository(env).get(input),
    create: (input) => service.create(input),
    deleteOwn: (input) => service.eraseOwnedByAgent(input),
    diff: (input) => DocsBranchDiffService.fromEnv(env).diff(input),
    previewSync: (input) => service.previewSync(input),
    synchronize: (input) => service.synchronize(input),
    buildPreview: (input) => DocsBranchPreview.fromEnv(env).build(input),
    uploadAsset: (input) => DocsBranchAssetUpload.fromEnv(env).upload(input),
  };
}

function createAssetUploadServices(
  env: Env,
  uploadOrigin: string,
): AssetUploadServices {
  const uploads = AgentAssetUploads.fromEnv(env);
  return {
    async create(input) {
      const created = await uploads.create(input);
      return {
        uploadId: created.uploadId,
        uploadUrl: new URL(`${AGENT_ASSET_UPLOAD_PATH}${created.uploadId}`, uploadOrigin).toString(),
        authorization: `${AGENT_ASSET_UPLOAD_AUTH_SCHEME} ${created.secret}`,
        expiresAt: created.expiresAt,
      };
    },
    takeFor: (uploadId, owner) => uploads.takeFor(uploadId, owner),
    discard: (ticket) => uploads.discard(ticket),
  };
}

function createProjectReader(env: Env): ProjectReader {
  const projects = new ProjectsRepository(env);
  const jobs = new JobsRepository(env);
  return {
    getForUser: (userId, projectId) => projects.getForUser(userId, projectId),
    latestGeneration: (projectId) => jobs.latestForProject(projectId),
    withDocsUrls: (list) => withPreferredDocsUrls(list, env),
  };
}

function createGenerationReader(env: Env): GenerationReader {
  const jobs = new JobsRepository(env);
  return {
    getDetail: (input) => jobs.getDetailForProject(input),
    listEvents: (jobId) => jobs.listEvents(jobId),
  };
}

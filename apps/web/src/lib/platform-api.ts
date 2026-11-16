import { generationStartResultSchema } from "@doxahq/contracts";
import { createApiError } from "~/lib/api-errors";
import type {
  PendingMerges,
  ApplyDocsContentEditsInput,
  ApplyDocsContentEditsResult,
  ConnectProjectRepositoryInput,
  CreateDocsDomainInput,
  CreateExampleProjectInput,
  CreateProjectInput,
  DocsContentMdxReport,
  DocsContentOverviewDto,
  DocsContentPageDetailDto,
  DocsDomainCollectionDto,
  DocsDomainDnsHost,
  DocsDomainDnsHostResponse,
  DocsDomainDto,
  DocsPreviewVisibility,
  DoxabotSettingsDto,
  GenerationDetailDto,
  GenerationJobDto,
  GenerationStartResultDto,
  GenerationsPageDto,
  GitHubRepositoryDto,
  JobEventDto,
  ProjectDto,
  ProjectGenerationCache,
  RepositoryBranchesDto,
  UpdateDoxabotSettingsInput,
  UpdateDocsPreviewVisibilityInput,
} from "@doxahq/contracts";
import type { BranchRef } from "@doxahq/contracts/docs-branches";
import type { ProjectOverview } from "@doxahq/contracts/project-overview";
import type { TeamRole } from "@doxahq/contracts/teams";
import type { ProjectBilling } from "@doxahq/contracts/billing";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";
const CONFIGURED_DOCS_BASE_DOMAIN = import.meta.env.VITE_DOCS_BASE_DOMAIN;
const DOCS_BASE_DOMAIN = CONFIGURED_DOCS_BASE_DOMAIN ?? "localhost";
// An empty value means "no local renderer": production sets it empty, so a
// developer's .env.local cannot add a port to production docs links.
const DOCS_RENDERER_BASE_URL = import.meta.env.VITE_DOCS_RENDERER_BASE_URL
  || (CONFIGURED_DOCS_BASE_DOMAIN ? undefined : "http://localhost:3002");
const DOCS_RUNTIME_URL = import.meta.env.VITE_DOCS_RUNTIME_URL ?? "http://localhost:8788";
const DEV_USER_ID = import.meta.env.VITE_DEV_USER_ID;

interface ApiOptions extends RequestInit {
  json?: unknown;
}

export function getDocsUrl(projectSlug: string): string {
  const generatedHostname = getGeneratedDocsHostname(projectSlug, DOCS_BASE_DOMAIN);
  if (generatedHostname) return getDocsHostnameUrl(generatedHostname)

  return `${DOCS_RUNTIME_URL.replace(/\/+$/, "")}/${projectSlug}`;
}

/**
 * The URL of a docs hostname, such as a branch preview. Local development
 * serves it through the renderer (`http://<host>:3002`), production on HTTPS.
 * The API builds the same URL with `createDocsHostnameUrl`.
 */
export function getDocsHostnameUrl(hostname: string): string {
  return getRendererUrl(hostname, DOCS_RENDERER_BASE_URL) ?? `https://${hostname}`
}

function getRendererUrl(hostname: string, baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/") return null;
    if (url.username || url.password || url.search || url.hash) return null;

    url.hostname = hostname;
    return url.origin;
  } catch {
    return null;
  }
}

function getGeneratedDocsHostname(projectSlug: string, baseDomain: string | undefined): string | null {
  const normalizedBaseDomain = normalizeHostname(baseDomain);
  if (!normalizedBaseDomain) return null;

  const normalizedSlug = normalizeHostname(projectSlug);
  if (!normalizedSlug || normalizedSlug.includes(".")) return null;

  return `${normalizedSlug}.${normalizedBaseDomain}`;
}

function normalizeHostname(hostname: string | undefined): string | null {
  const normalized = hostname?.trim().toLowerCase().replace(/\.+$/, "") ?? "";
  return normalized || null;
}

export function getApiUrl(path: string): string {
  return `${API_BASE_URL.replace(/\/+$/, "")}${path}`;
}

/** True in local dev when requests sign in with the `x-doxa-user-id` header, not a cookie. */
export function usesDevUserHeader(): boolean {
  return Boolean(DEV_USER_ID);
}

export function getApiRequestHeaders(initialHeaders?: HeadersInit): Headers {
  const headers = new Headers(initialHeaders);
  if (DEV_USER_ID) headers.set("x-doxa-user-id", DEV_USER_ID);
  return headers;
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = getApiRequestHeaders(options.headers);
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) throw createApiError(response.status, payload);

  return payload as T;
}

export async function listProjects(): Promise<ProjectDto[]> {
  const result = await apiFetch<{ projects: ProjectDto[] }>("/projects");
  return result.projects;
}

export async function listRepositories(): Promise<GitHubRepositoryDto[]> {
  const result = await apiFetch<{ repositories: GitHubRepositoryDto[] }>("/github/repos");
  return result.repositories;
}

/** The branches of a repository of the user's GitHub installations, for a new project. */
export async function listRepositoryBranches(githubRepositoryId: string): Promise<RepositoryBranchesDto> {
  return apiFetch<RepositoryBranchesDto>(`/github/repos/${encodeURIComponent(githubRepositoryId)}/branches`)
}

/** The branches of the project's repository, for its production branch setting. */
export async function listProjectRepositoryBranches(projectId: string): Promise<RepositoryBranchesDto> {
  return apiFetch<RepositoryBranchesDto>(`/projects/${encodeURIComponent(projectId)}/doxabot/branches`)
}

export async function createProject(input: CreateProjectInput) {
  const result = await apiFetch<{ project: ProjectDto }>("/projects", {
    method: "POST",
    json: input,
  });
  return result.project;
}

/**
 * Creates a project without a repository. It starts with the starter docs, or
 * with one empty page when `template` is "empty".
 */
export async function createExampleProject(input: CreateExampleProjectInput) {
  const result = await apiFetch<{ project: ProjectDto }>("/projects/example", {
    method: "POST",
    json: input,
  });
  return result.project;
}

export async function connectProjectRepository(projectId: string, input: ConnectProjectRepositoryInput) {
  const result = await apiFetch<{ project: ProjectDto }>(
    `/projects/${encodeURIComponent(projectId)}/repository`,
    {
      method: "PUT",
      json: input,
    },
  );
  return result.project;
}

/** Deletes a project permanently. Its stored files are collected later. */
export async function deleteProject(projectId: string): Promise<void> {
  await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  })
}

/** `role` is the viewer's role on the project; `owner` for their own personal project. */
export async function getProject(projectId: string) {
  // `billing` is null while billing is off on the server (billing spec 15.1),
  // and missing from an older API: both hide every billing control.
  return apiFetch<{
    project: ProjectDto;
    latestJob: GenerationJobDto | null;
    role: TeamRole;
    billing?: ProjectBilling | null;
  }>(`/projects/${projectId}`);
}

/**
 * `GET /projects/:projectId/shell`: the project layout's and the Overview's
 * reads in one request. The body is checked section by section in
 * `lib/queries/project-shell.ts`, so it stays unknown here.
 */
export async function getProjectShell(projectId: string): Promise<unknown> {
  return apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/shell`);
}

/**
 * `force` confirms a start that the server asked about. `seed` starts a
 * first generation from the pages written in the editor.
 */
export interface GenerationStartOptions {
  force?: boolean
  seed?: boolean
}

function generationStartSearch(input: GenerationStartOptions): string {
  const query = new URLSearchParams()
  if (input.force) query.set("force", "true")
  if (input.seed) query.set("seed", "true")
  return query.size > 0 ? `?${query}` : ""
}

export async function startGeneration(
  projectId: string,
  input: GenerationStartOptions = {},
): Promise<GenerationStartResultDto> {
  const result = await apiFetch<unknown>(
    `/projects/${encodeURIComponent(projectId)}/generate${generationStartSearch(input)}`,
    {
      method: "POST",
    },
  );
  return generationStartResultSchema.parse(result);
}

/**
 * Starts a failed generation again: a production run on the production branch
 * as it is now, a preview run on its pull request's head. The answer reads
 * like a start, with the same confirmations.
 */
export async function rerunProjectGeneration(
  projectId: string,
  generationId: string,
  input: GenerationStartOptions = {},
): Promise<GenerationStartResultDto> {
  const result = await apiFetch<unknown>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/rerun${generationStartSearch(input)}`,
    { method: "POST" },
  );
  return generationStartResultSchema.parse(result);
}

/**
 * Continues a failed generation from the step that failed, on the same
 * commit and settings. Answers with the generation, running again.
 */
export async function resumeProjectGeneration(
  projectId: string,
  generationId: string,
): Promise<GenerationDetailDto> {
  const result = await apiFetch<{ generation: GenerationDetailDto }>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/resume`,
    { method: "POST" },
  );
  return result.generation;
}

export async function listProjectGenerations(
  projectId: string,
  input: { limit: number; cursor: string | null },
): Promise<GenerationsPageDto> {
  const searchParams = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor) searchParams.set("cursor", input.cursor);

  return apiFetch<GenerationsPageDto>(`/projects/${projectId}/generations?${searchParams.toString()}`);
}

export async function getProjectGeneration(
  projectId: string,
  generationId: string,
): Promise<GenerationDetailDto> {
  const result = await apiFetch<{ generation: GenerationDetailDto }>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}`,
  );
  return result.generation;
}

export async function promoteProjectGeneration(
  projectId: string,
  generationId: string,
): Promise<GenerationDetailDto> {
  const result = await apiFetch<{ generation: GenerationDetailDto }>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/promote`,
    { method: "POST" },
  );
  return result.generation;
}

export async function deleteProjectGeneration(
  projectId: string,
  generationId: string,
): Promise<void> {
  await apiFetch<unknown>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}`,
    { method: "DELETE" },
  );
}

export async function cancelProjectGeneration(
  projectId: string,
  generationId: string,
): Promise<GenerationDetailDto> {
  const result = await apiFetch<{ generation: GenerationDetailDto }>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/cancel`,
    { method: "POST" },
  );
  return result.generation;
}

export async function listProjectGenerationEvents(
  projectId: string,
  generationId: string,
): Promise<JobEventDto[]> {
  const result = await apiFetch<{ events: JobEventDto[] }>(
    `/projects/${projectId}/generations/${generationId}/events`,
  );
  return result.events;
}

export async function listDocsDomains(projectId: string): Promise<DocsDomainCollectionDto> {
  return apiFetch<DocsDomainCollectionDto>(`/projects/${projectId}/docs-domains`);
}

/** The generation cache with the temperature of the next runs (billing decision D21). */
export type GenerationCacheDto = ProjectGenerationCache

export interface ProjectPreviewVisibilityDto {
  previewVisibility: DocsPreviewVisibility
}

export async function getProjectPreviewVisibility(
  projectId: string,
): Promise<ProjectPreviewVisibilityDto> {
  return apiFetch<ProjectPreviewVisibilityDto>(
    `/projects/${encodeURIComponent(projectId)}/preview-visibility`,
  )
}

export async function updateProjectPreviewVisibility(
  projectId: string,
  input: UpdateDocsPreviewVisibilityInput,
): Promise<ProjectPreviewVisibilityDto> {
  return apiFetch<ProjectPreviewVisibilityDto>(
    `/projects/${encodeURIComponent(projectId)}/preview-visibility`,
    { method: "PUT", json: input },
  )
}

export async function getProjectGenerationCache(
  projectId: string,
): Promise<GenerationCacheDto> {
  const result = await apiFetch<{ generationCache: GenerationCacheDto }>(
    `/projects/${encodeURIComponent(projectId)}/generation-cache`,
  );
  return result.generationCache;
}

export async function clearProjectGenerationCache(
  projectId: string,
): Promise<GenerationCacheDto> {
  const result = await apiFetch<{ generationCache: GenerationCacheDto }>(
    `/projects/${encodeURIComponent(projectId)}/generation-cache/clear`,
    { method: "POST" },
  );
  return result.generationCache;
}

export async function getProjectDoxabotSettings(
  projectId: string,
): Promise<DoxabotSettingsDto> {
  const result = await apiFetch<{ settings: DoxabotSettingsDto }>(
    `/projects/${encodeURIComponent(projectId)}/doxabot`,
  );
  return result.settings;
}

/** Pull requests merged since the last production generation started. */
export async function listPendingMerges(projectId: string): Promise<PendingMerges["merges"]> {
  const result = await apiFetch<PendingMerges>(
    `/projects/${encodeURIComponent(projectId)}/doxabot/pending-merges`,
  );
  return result.merges;
}

export async function updateProjectDoxabotSettings(
  projectId: string,
  input: UpdateDoxabotSettingsInput,
): Promise<DoxabotSettingsDto> {
  const result = await apiFetch<{ settings: DoxabotSettingsDto }>(
    `/projects/${encodeURIComponent(projectId)}/doxabot`,
    {
      method: "PUT",
      json: input,
    },
  );
  return result.settings;
}

export async function createDocsDomain(
  projectId: string,
  input: CreateDocsDomainInput,
): Promise<DocsDomainDto> {
  const result = await apiFetch<{ domain: DocsDomainDto }>(`/projects/${projectId}/docs-domains`, {
    method: "POST",
    json: input,
  });
  return result.domain;
}

export async function deleteDocsDomain(projectId: string, domainId: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/projects/${projectId}/docs-domains/${domainId}`, {
    method: "DELETE",
  });
}

export async function refreshDocsDomain(projectId: string, domainId: string): Promise<DocsDomainDto> {
  const result = await apiFetch<{ domain: DocsDomainDto }>(`/projects/${projectId}/docs-domains/${domainId}/refresh`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  return result.domain;
}

/** The DNS host of a custom domain, from the nameservers of its zone. */
export async function getDocsDomainDnsHost(projectId: string, domainId: string): Promise<DocsDomainDnsHost> {
  const result = await apiFetch<DocsDomainDnsHostResponse>(
    `/projects/${projectId}/docs-domains/${domainId}/dns-host`,
    { signal: AbortSignal.timeout(15_000) },
  );
  return result.dnsHost;
}

export async function getProjectContent(
  projectId: string,
  branch: BranchRef,
): Promise<DocsContentOverviewDto> {
  const searchParams = new URLSearchParams({ branch })
  const result = await apiFetch<{ content: DocsContentOverviewDto }>(
    `/projects/${encodeURIComponent(projectId)}/content?${searchParams.toString()}`,
  );
  return result.content;
}

export async function getProjectContentPage(
  projectId: string,
  href: string,
  branch: BranchRef,
): Promise<DocsContentPageDetailDto> {
  const searchParams = new URLSearchParams({ href, branch });
  const result = await apiFetch<{ page: DocsContentPageDetailDto }>(
    `/projects/${encodeURIComponent(projectId)}/content/page?${searchParams.toString()}`,
  );
  return result.page;
}

/** Saves an edit list. The result lists the saved pages that fail the MDX check. */
export async function applyProjectContentEdits(
  projectId: string,
  input: Omit<ApplyDocsContentEditsInput, "branch"> & { branch?: ApplyDocsContentEditsInput["branch"] },
): Promise<ApplyDocsContentEditsResult> {
  return apiFetch<ApplyDocsContentEditsResult>(
    `/projects/${encodeURIComponent(projectId)}/content/edits`,
    { method: "POST", json: { ...input, branch: input.branch ?? "main" } },
  );
}

/** What the project Overview shows beside the project itself. */
export async function getProjectOverview(projectId: string): Promise<ProjectOverview> {
  return apiFetch<ProjectOverview>(`/projects/${encodeURIComponent(projectId)}/overview`);
}

/** The changed pages of a branch that fail the MDX check, which block a publish. */
export async function getProjectContentMdxReport(
  projectId: string,
  branch: BranchRef,
): Promise<DocsContentMdxReport> {
  const searchParams = new URLSearchParams({ branch });
  return apiFetch<DocsContentMdxReport>(
    `/projects/${encodeURIComponent(projectId)}/content/mdx-issues?${searchParams.toString()}`,
  );
}

export async function discardProjectContentBranch(
  projectId: string,
  branch: BranchRef,
): Promise<void> {
  await apiFetch<{ revision: number }>(`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/discard`, {
    method: "POST",
  });
}

export async function getJob(jobId: string): Promise<GenerationJobDto> {
  const result = await apiFetch<{ job: GenerationJobDto }>(`/jobs/${jobId}`);
  return result.job;
}

export async function listJobEvents(jobId: string): Promise<JobEventDto[]> {
  const result = await apiFetch<{ events: JobEventDto[] }>(`/jobs/${jobId}/events`);
  return result.events;
}

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import type { GitHubRepositoryDto } from "@doxahq/contracts"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { getErrorMessage } from "~/lib/errors"
import {
  getJob,
  getProject,
  getProjectContent,
  getProjectContentMdxReport,
  getProjectOverview,
  getProjectContentPage,
  getProjectDoxabotSettings,
  getProjectGenerationCache,
  getProjectPreviewVisibility,
  getProjectGeneration,
  getDocsDomainDnsHost,
  listDocsDomains,
  listJobEvents,
  listPendingMerges,
  listProjectGenerationEvents,
  listProjectGenerations,
  listProjectRepositoryBranches,
  listProjects,
  listGitHubInstallations,
  listRepositoryBranches,
  listRepositories,
} from "~/lib/platform-api"
import { fromProjectShell } from "~/lib/queries/project-shell"

/**
 * The repositories the GitHub App can read. A failed list is a result with an
 * error, not a failed query, so the screens that show it keep working.
 */
export interface GitHubRepositoriesResult {
  repositories: GitHubRepositoryDto[]
  error: string | null
}

export type ProjectDetail = Awaited<ReturnType<typeof getProject>>

export const dashboardQueryKeys = {
  all: ["dashboard"] as const,
  /** The account-level lists. Invalidating it refreshes both lists below. */
  summary: () => [...dashboardQueryKeys.all, "summary"] as const,
  projects: () => [...dashboardQueryKeys.summary(), "projects"] as const,
  githubRepositories: () => [...dashboardQueryKeys.summary(), "github-repositories"] as const,
  githubInstallations: () => [...dashboardQueryKeys.summary(), "github-installations"] as const,
  githubRepositoryBranches: (githubRepositoryId: string) =>
    [...dashboardQueryKeys.githubRepositories(), githubRepositoryId, "branches"] as const,
  project: (projectId: string) => [...dashboardQueryKeys.all, "projects", projectId] as const,
  overview: (projectId: string) => [...dashboardQueryKeys.project(projectId), "overview"] as const,
  contentRoot: (projectId: string) => [...dashboardQueryKeys.project(projectId), "content"] as const,
  content: (projectId: string, branch: BranchRef) =>
    [...dashboardQueryKeys.contentRoot(projectId), branch] as const,
  contentPage: (projectId: string, branch: BranchRef, href: string) =>
    [...dashboardQueryKeys.content(projectId, branch), "pages", href] as const,
  /** Under `content`, so every edit, sync, discard and publish refreshes it. */
  contentMdxReport: (projectId: string, branch: BranchRef) =>
    [...dashboardQueryKeys.content(projectId, branch), "mdx-issues"] as const,
  domains: (projectId: string) => [...dashboardQueryKeys.project(projectId), "domains"] as const,
  /** Under the project key, so Check again also looks up the DNS host again. */
  domainDnsHost: (projectId: string, domainId: string) =>
    [...dashboardQueryKeys.project(projectId), "domain-dns-host", domainId] as const,
  doxabot: (projectId: string) => [...dashboardQueryKeys.project(projectId), "doxabot"] as const,
  /** Not under `doxabot`, so saving a setting does not list the branches again. */
  repositoryBranches: (projectId: string) =>
    [...dashboardQueryKeys.project(projectId), "repository-branches"] as const,
  pendingMerges: (projectId: string) =>
    [...dashboardQueryKeys.project(projectId), "pending-merges"] as const,
  generationCache: (projectId: string) =>
    [...dashboardQueryKeys.project(projectId), "generation-cache"] as const,
  previewVisibility: (projectId: string) =>
    [...dashboardQueryKeys.project(projectId), "preview-visibility"] as const,
  generations: (projectId: string) => [...dashboardQueryKeys.project(projectId), "generations"] as const,
  generation: (projectId: string, generationId: string) => [
    ...dashboardQueryKeys.generations(projectId),
    generationId,
  ] as const,
  generationEvents: (projectId: string, generationId: string) => [
    ...dashboardQueryKeys.generation(projectId, generationId),
    "events",
  ] as const,
  job: (jobId: string) => [...dashboardQueryKeys.all, "jobs", jobId] as const,
  events: (jobId: string) => [...dashboardQueryKeys.job(jobId), "events"] as const,
}

/**
 * The projects list changes only through mutations, and each of them
 * invalidates it, so it stays fresh for minutes. The shell, the project
 * switcher and ⌘K then share it with no request on each mount.
 */
const PROJECTS_STALE_TIME_MS = 5 * 60_000

export function projectsListQueryOptions() {
  return queryOptions({
    queryKey: dashboardQueryKeys.projects(),
    queryFn: listProjects,
    staleTime: PROJECTS_STALE_TIME_MS,
  })
}

/** Only the screens that show repositories use it, so other pages skip the request. */
export function githubRepositoriesQueryOptions() {
  return queryOptions({
    queryKey: dashboardQueryKeys.githubRepositories(),
    queryFn: loadGitHubRepositories,
    staleTime: 10_000,
  })
}

/** The installations the user owns and the transfer targets, for Account settings. */
export function githubInstallationsQueryOptions() {
  return queryOptions({
    queryKey: dashboardQueryKeys.githubInstallations(),
    queryFn: listGitHubInstallations,
    staleTime: 10_000,
  })
}

export function projectDetailQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.project(projectId),
    queryFn: (context) => fromProjectShell(context, projectId, "project", () => getProject(projectId)),
    staleTime: 5_000,
  })
}

export function projectContentQueryOptions(projectId: string, branch: BranchRef) {
  return queryOptions({
    queryKey: dashboardQueryKeys.content(projectId, branch),
    queryFn: () => getProjectContent(projectId, branch),
    staleTime: 5_000,
    retry: false,
  })
}

export function projectContentMdxReportQueryOptions(projectId: string, branch: BranchRef) {
  return queryOptions({
    queryKey: dashboardQueryKeys.contentMdxReport(projectId, branch),
    queryFn: () => getProjectContentMdxReport(projectId, branch),
    staleTime: 5_000,
    retry: false,
  })
}

export function projectContentPageQueryOptions(
  projectId: string,
  branch: BranchRef,
  href: string | null,
) {
  return queryOptions({
    queryKey: dashboardQueryKeys.contentPage(projectId, branch, href ?? ""),
    queryFn: () => getProjectContentPage(projectId, href ?? "/", branch),
    enabled: href !== null,
    // Page sources are only changed through this editor, so the cached copy
    // stays authoritative until a mutation replaces it.
    staleTime: Infinity,
    retry: false,
  })
}

export function docsDomainsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.domains(projectId),
    queryFn: (context) => fromProjectShell(context, projectId, "docsDomains", () => listDocsDomains(projectId)),
    staleTime: 5_000,
  })
}

export function docsDomainDnsHostQueryOptions(projectId: string, domainId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.domainDnsHost(projectId, domainId),
    queryFn: () => getDocsDomainDnsHost(projectId, domainId),
    // Nameservers rarely change. The lookup runs again only after an invalidation.
    staleTime: Infinity,
    // A failed lookup only hides the provider steps, so do not delay the generic steps.
    retry: false,
  })
}

/** Under the project key, so a project-wide invalidation refreshes it too. */
export function projectOverviewQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.overview(projectId),
    queryFn: (context) => fromProjectShell(context, projectId, "overview", () => getProjectOverview(projectId)),
    staleTime: 15_000,
    retry: false,
  })
}

/** Pull requests merged since the last production generation started. */
export function pendingMergesQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.pendingMerges(projectId),
    queryFn: (context) => fromProjectShell(context, projectId, "pendingMerges", () => listPendingMerges(projectId)),
    staleTime: 30_000,
    retry: false,
  })
}

/** Branches change on GitHub, not here, so a short stale time keeps the picker current. */
/** Branches change rarely. An older list still shows at once and loads again behind it. */
const BRANCHES_STALE_TIME_MS = 5 * 60_000

/** The branches of a repository that has no project yet. */
export function githubRepositoryBranchesQueryOptions(githubRepositoryId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.githubRepositoryBranches(githubRepositoryId),
    queryFn: () => listRepositoryBranches(githubRepositoryId),
    staleTime: BRANCHES_STALE_TIME_MS,
    retry: false,
  })
}

/** The branches of the project's repository. */
export function projectRepositoryBranchesQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.repositoryBranches(projectId),
    queryFn: () => listProjectRepositoryBranches(projectId),
    staleTime: BRANCHES_STALE_TIME_MS,
    retry: false,
  })
}

export function projectDoxabotQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.doxabot(projectId),
    queryFn: (context) =>
      fromProjectShell(context, projectId, "doxabot", () => getProjectDoxabotSettings(projectId)),
    staleTime: 5_000,
  })
}

export function projectGenerationCacheQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.generationCache(projectId),
    queryFn: () => getProjectGenerationCache(projectId),
    staleTime: 5_000,
  })
}

export function projectPreviewVisibilityQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.previewVisibility(projectId),
    queryFn: () => getProjectPreviewVisibility(projectId),
    staleTime: 5_000,
  })
}

export function projectGenerationsQueryOptions(projectId: string) {
  return infiniteQueryOptions({
    queryKey: dashboardQueryKeys.generations(projectId),
    queryFn: (context) => {
      const fetchPage = () => listProjectGenerations(projectId, { limit: 20, cursor: context.pageParam })
      // The shell holds the first page only.
      return context.pageParam === null ? fromProjectShell(context, projectId, "generations", fetchPage) : fetchPage()
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 2_500,
  })
}

export function projectGenerationQueryOptions(projectId: string, generationId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.generation(projectId, generationId),
    queryFn: () => getProjectGeneration(projectId, generationId),
    staleTime: 2_500,
  })
}

export function projectGenerationEventsQueryOptions(projectId: string, generationId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.generationEvents(projectId, generationId),
    queryFn: () => listProjectGenerationEvents(projectId, generationId),
    staleTime: 2_500,
  })
}

export function generationJobQueryOptions(jobId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.job(jobId),
    queryFn: () => getJob(jobId),
    staleTime: 2_500,
  })
}

export function jobEventsQueryOptions(jobId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.events(jobId),
    queryFn: () => listJobEvents(jobId),
    staleTime: 2_500,
  })
}

async function loadGitHubRepositories(): Promise<GitHubRepositoriesResult> {
  try {
    return { repositories: await listRepositories(), error: null }
  } catch (error) {
    return { repositories: [], error: getErrorMessage(error, "Failed to load repositories.") }
  }
}

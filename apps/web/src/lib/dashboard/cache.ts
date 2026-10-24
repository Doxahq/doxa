import type {
  DocsDomainDto,
  GenerationDetailDto,
  GenerationJobDto,
  GenerationsPageDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts"
import type { InfiniteData, QueryClient } from "@tanstack/react-query"

import {
  dashboardQueryKeys,
  type ProjectDetail,
} from "~/lib/queries/dashboard"

/** Puts a new or changed project first in the cached projects list. */
export function mergeProjectIntoList(
  projects: ProjectDto[] | undefined,
  project: ProjectDto,
): ProjectDto[] | undefined {
  if (!projects) return projects

  return [project, ...projects.filter((current) => current.id !== project.id)]
}

export function removeProjectFromList(
  projects: ProjectDto[] | undefined,
  projectId: string,
): ProjectDto[] | undefined {
  if (!projects) return projects

  return projects.filter((current) => current.id !== projectId)
}

export function appendDomain(
  domains: DocsDomainDto[] | undefined,
  domain: DocsDomainDto,
): DocsDomainDto[] {
  return [...(domains ?? []), domain]
}

export function replaceDomain(
  domains: DocsDomainDto[] | undefined,
  nextDomain: DocsDomainDto,
): DocsDomainDto[] {
  return (domains ?? []).map((domain) => (
    domain.id === nextDomain.id ? nextDomain : domain
  ))
}

export function removeDomain(
  domains: DocsDomainDto[] | undefined,
  domainId: string,
): DocsDomainDto[] {
  return (domains ?? []).filter((domain) => domain.id !== domainId)
}

export async function invalidateProjectDomainQueries(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
  ])
}

export function withLatestJob(
  projectDetail: ProjectDetail | undefined,
  latestJob: GenerationJobDto,
): ProjectDetail | undefined {
  if (!projectDetail) return projectDetail

  return {
    ...projectDetail,
    latestJob,
  }
}

export function cacheStartedGeneration(
  queryClient: QueryClient,
  projectId: string,
  job: GenerationJobDto,
  options: PendingGenerationOptions = {},
): void {
  queryClient.setQueryData<GenerationDetailDto | undefined>(
    dashboardQueryKeys.generation(projectId, job.id),
    (detail) => mergeGenerationDetail(detail, job) ?? createPendingGenerationDetail(job, options),
  )
  queryClient.setQueryData<ProjectDetail | undefined>(
    dashboardQueryKeys.project(projectId),
    (projectDetail) => withLatestJob(projectDetail, job),
  )
}

/**
 * Placeholder detail for a generation that the server accepted a moment ago.
 * The detail page reads this while the first fetch runs. Every field holds the
 * value that the API returns for a queued manual generation.
 */
export interface PendingGenerationOptions {
  /** The failed run that the new run starts again. */
  rerunOfId?: string
}

export function createPendingGenerationDetail(
  job: GenerationJobDto,
  { rerunOfId }: PendingGenerationOptions = {},
): GenerationDetailDto {
  return {
    ...job,
    trigger: "manual",
    author: {
      kind: "user",
      displayName: "You",
      githubLogin: null,
      avatarUrl: null,
    },
    source: {
      provider: null,
      repositoryFullName: null,
      repositoryUrl: null,
      branch: null,
      branchUrl: null,
      commit: null,
      changeProposal: null,
    },
    deployment: {
      environment: "production",
      isCurrent: false,
      state: "not_published",
      docsVersionId: job.docsVersionId,
      versionNumber: null,
      visitUrl: null,
      domains: [],
    },
    actions: {
      canPromote: false,
      canDelete: false,
      canRerun: false,
      promoteBlockedReason: "not_succeeded",
      deleteBlockedReason: "in_progress",
      rerunBlockedReason: "not_finished",
      canResume: false,
      resumeBlockedReason: "not_resumable",
    },
    rerunLinks: { rerunOfId: rerunOfId ?? null, rerunId: null },
    flaggedPages: [],
    referenceSource: null,
  }
}

/** Links a failed run to the run that started it again. */
export function withRerunId(
  detail: GenerationDetailDto | undefined,
  rerunId: string,
): GenerationDetailDto | undefined {
  if (!detail) return detail
  return { ...detail, rerunLinks: { ...detail.rerunLinks, rerunId } }
}

export function mergeLatestJob(
  projectDetail: ProjectDetail | undefined,
  generation: GenerationJobDto,
): ProjectDetail | undefined {
  if (!projectDetail) return projectDetail
  if (
    projectDetail.latestJob
    && projectDetail.latestJob.id !== generation.id
    && projectDetail.latestJob.createdAt > generation.createdAt
  ) {
    return projectDetail
  }

  return { ...projectDetail, latestJob: generation }
}

export function mergeGenerationIntoPages(
  data: InfiniteData<GenerationsPageDto> | undefined,
  generation: GenerationJobDto,
): InfiniteData<GenerationsPageDto> | undefined {
  if (!data) return data

  let found = false
  const pages = data.pages.map((page) => ({
    ...page,
    generations: page.generations.map((current) => {
      if (current.id !== generation.id) return current
      found = true
      return generation
    }),
  }))

  if (!found && pages[0]) {
    pages[0] = {
      ...pages[0],
      generations: [generation, ...pages[0].generations],
    }
  }

  return { ...data, pages }
}

export function mergeGenerationDetail(
  detail: GenerationDetailDto | undefined,
  generation: GenerationJobDto,
): GenerationDetailDto | undefined {
  return detail ? { ...detail, ...generation } : detail
}

export function appendGenerationEvent(
  events: JobEventDto[] | undefined,
  event: JobEventDto,
): JobEventDto[] {
  const existing = events ?? []
  if (existing.some((current) => current.id === event.id || current.sequence === event.sequence)) {
    return existing
  }

  return [...existing, event].sort((left, right) => left.sequence - right.sequence)
}

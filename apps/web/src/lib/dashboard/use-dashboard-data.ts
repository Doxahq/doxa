import { useEffect, useMemo, useState, type FormEvent } from "react"
import type {
  DocsDomainCollectionDto,
  DocsDomainDto,
  GenerationJobDto,
  GitHubRepositoryDto,
  JobEventDto,
  ProjectDto,
} from "@doxahq/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  appendDomain,
  invalidateProjectDomainQueries,
  mergeProjectIntoList,
  removeDomain,
  replaceDomain,
  withLatestJob,
} from "~/lib/dashboard/cache"
import { hasReachedCustomDomainLimit } from "~/lib/dashboard/domain-limit"
import {
  formatElapsed,
  getJobProgress,
  isTerminalJob,
  type LoadState,
} from "~/lib/dashboard/model"
import { signIn as startSignIn, type SignInProvider } from "~/lib/auth/use-auth-session"
import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  docsDomainsQueryOptions,
  generationJobQueryOptions,
  jobEventsQueryOptions,
  githubRepositoriesQueryOptions,
  projectDetailQueryOptions,
  projectsListQueryOptions,
  type ProjectDetail,
} from "~/lib/queries/dashboard"
import {
  createDocsDomain,
  createProject,
  deleteDocsDomain,
  getDocsUrl,
  refreshDocsDomain,
  startGeneration,
} from "~/lib/platform-api"


export interface DashboardData {
  loadState: LoadState
  error: string | null
  repositoriesError: string | null
  projects: ProjectDto[]
  repositories: GitHubRepositoryDto[]
  selectedRepositoryId: string
  selectedRepository: GitHubRepositoryDto | null
  activeProject: ProjectDto | null
  docsDomains: DocsDomainDto[]
  domainsError: string | null
  domainHostname: string
  job: GenerationJobDto | null
  events: JobEventDto[]
  actionError: string | null
  isLoadingDomains: boolean
  isCreatingDomain: boolean
  refreshingDomainId: string | null
  deletingDomainId: string | null
  docsUrl: string | null
  generationActive: boolean
  generationButtonLabel: string
  jobProgress: number
  latestEvent: JobEventDto | null
  elapsedLabel: string | null
  showLocalInstallCallback: boolean
  loadDashboard: () => Promise<void>
  signIn: (provider: SignInProvider) => Promise<void>
  setSelectedRepositoryId: (repositoryId: string) => void
  setActiveProject: (project: ProjectDto) => void
  setDomainHostname: (hostname: string) => void
  createSelectedProject: () => Promise<void>
  addDocsDomain: (event: FormEvent<HTMLFormElement>) => Promise<void>
  deleteProjectDomain: (domainId: string) => Promise<string | null>
  refreshProjectDomain: (domainId: string) => Promise<void>
  generateDocs: () => Promise<void>
}

const SHOW_LOCAL_INSTALL_CALLBACK = Boolean(import.meta.env.DEV || import.meta.env.VITE_DEV_USER_ID)
const DASHBOARD_POLL_INTERVAL_MS = 2_500
const LOCAL_STARTED_EVENT_SEQUENCE = 1

export function useDashboardData(): DashboardData {
  const queryClient = useQueryClient()
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>("")
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [domainHostname, setDomainHostname] = useState("")
  const [domainValidationError, setDomainValidationError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const projectsQuery = useQuery(projectsListQueryOptions())
  const repositoriesQuery = useQuery(githubRepositoriesQueryOptions())
  const projects = projectsQuery.data ?? []
  const repositories = repositoriesQuery.data?.repositories ?? []
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  )
  const activeProjectIdValue = activeProject?.id ?? ""

  const projectQuery = useQuery({
    ...projectDetailQueryOptions(activeProjectIdValue),
    enabled: Boolean(activeProjectIdValue),
  })

  const latestJobFromProject = projectQuery.data?.latestJob ?? null
  const latestJobId = latestJobFromProject?.id ?? ""
  const jobQuery = useQuery({
    ...generationJobQueryOptions(latestJobId),
    enabled: Boolean(latestJobId),
    refetchInterval: ({ state }) => {
      const currentJob = state.data ?? latestJobFromProject
      return currentJob && !isTerminalJob(currentJob) ? DASHBOARD_POLL_INTERVAL_MS : false
    },
  })
  const job = jobQuery.data ?? latestJobFromProject
  const jobId = job?.id ?? ""
  const eventsQuery = useQuery({
    ...jobEventsQueryOptions(jobId),
    enabled: Boolean(jobId),
    refetchInterval: job && !isTerminalJob(job) ? DASHBOARD_POLL_INTERVAL_MS : false,
  })

  const domainsQuery = useQuery({
    ...docsDomainsQueryOptions(activeProjectIdValue),
    enabled: Boolean(activeProjectIdValue),
  })

  const loadedProjects = projectsQuery.data
  useEffect(() => {
    if (!loadedProjects) return

    setActiveProjectId((currentProjectId) => {
      if (currentProjectId && loadedProjects.some((project) => project.id === currentProjectId)) {
        return currentProjectId
      }

      return loadedProjects[0]?.id ?? null
    })
  }, [loadedProjects])

  const loadedRepositories = repositoriesQuery.data?.repositories
  useEffect(() => {
    if (!loadedRepositories) return

    setSelectedRepositoryId((currentRepositoryId) => {
      if (currentRepositoryId && loadedRepositories.some((repo) => repo.id === currentRepositoryId)) {
        return currentRepositoryId
      }

      return loadedRepositories[0]?.id ?? ""
    })
  }, [loadedRepositories])

  useEffect(() => {
    setDomainHostname("")
    setDomainValidationError(null)
  }, [activeProjectIdValue])

  useEffect(() => {
    if (!job || isTerminalJob(job)) return

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [job])

  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.setQueryData(
        dashboardQueryKeys.projects(),
        (current: ProjectDto[] | undefined) => mergeProjectIntoList(current, project),
      )
      setActiveProjectId(project.id)
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })
    },
  })

  const createDomainMutation = useMutation({
    mutationFn: ({ projectId, hostname }: { projectId: string; hostname: string }) =>
      createDocsDomain(projectId, { hostname }),
    onSuccess: (domain, variables) => {
      queryClient.setQueryData(
        dashboardQueryKeys.domains(variables.projectId),
        (collection: DocsDomainCollectionDto | undefined) => collection
          ? { ...collection, domains: appendDomain(collection.domains, domain) }
          : collection,
      )
      setDomainHostname("")
    },
    onSettled: async (_domain, _error, variables) => {
      if (!variables) return
      await invalidateProjectDomainQueries(queryClient, variables.projectId)
    },
  })

  const refreshDomainMutation = useMutation({
    mutationFn: ({ projectId, domainId }: { projectId: string; domainId: string }) =>
      refreshDocsDomain(projectId, domainId),
    onSuccess: (domain, variables) => {
      queryClient.setQueryData(
        dashboardQueryKeys.domains(variables.projectId),
        (collection: DocsDomainCollectionDto | undefined) => collection
          ? { ...collection, domains: replaceDomain(collection.domains, domain) }
          : collection,
      )
    },
    onSettled: async (_domain, _error, variables) => {
      if (!variables) return
      await invalidateProjectDomainQueries(queryClient, variables.projectId)
    },
  })

  const deleteDomainMutation = useMutation({
    mutationFn: async ({ projectId, domainId }: { projectId: string; domainId: string }) => {
      await deleteDocsDomain(projectId, domainId)
      return { projectId, domainId }
    },
    onSuccess: ({ projectId, domainId }) => {
      queryClient.setQueryData(
        dashboardQueryKeys.domains(projectId),
        (collection: DocsDomainCollectionDto | undefined) => collection
          ? { ...collection, domains: removeDomain(collection.domains, domainId) }
          : collection,
      )
      toast.success("Custom domain deleted")
    },
    onSettled: async (_result, _error, variables) => {
      if (!variables) return
      await invalidateProjectDomainQueries(queryClient, variables.projectId)
    },
  })

  const generateDocsMutation = useMutation({
    mutationFn: (projectId: string) => startGeneration(projectId),
    onSuccess: (result, projectId) => {
      const { outcome, message } = result
      if (outcome === "confirmation_required") {
        toast.info(message)
        return
      }
      const nextJob = result.job
      queryClient.setQueryData(dashboardQueryKeys.job(nextJob.id), nextJob)
      queryClient.setQueryData<ProjectDetail | undefined>(
        dashboardQueryKeys.project(projectId),
        (projectDetail) => withLatestJob(projectDetail, nextJob),
      )
      if (outcome === "already_active") {
        if (message) toast.info(message)
      } else {
        queryClient.setQueryData(dashboardQueryKeys.events(nextJob.id), [
          createLocalStartedEvent(nextJob),
        ])
      }
    },
    onSettled: async (_job, _error, projectId) => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) })
    },
  })

  const selectedRepository = useMemo(
    () => repositories.find((repo) => repo.id === selectedRepositoryId) ?? null,
    [repositories, selectedRepositoryId],
  )
  const events = eventsQuery.data ?? []
  const docsDomains = domainsQuery.data?.domains ?? []
  const customDomainLimit = domainsQuery.data?.customDomainLimit ?? 0
  const canAddDocsDomain = domainsQuery.isSuccess
    && !hasReachedCustomDomainLimit(docsDomains, customDomainLimit)
  const docsUrl = activeProject ? activeProject.docsUrl ?? getDocsUrl(activeProject.slug) : null
  const generationActive = generateDocsMutation.isPending || job?.status === "queued" || job?.status === "running"
  const generationButtonLabel = generateDocsMutation.isPending
    ? "Starting"
    : generationActive
      ? "Generating"
      : job?.status === "failed" || job?.status === "cancelled" || job?.status === "stopped_credits"
        ? "Retry generation"
        : "Generate docs"
  const jobProgress = job ? getJobProgress(job, events) : 0
  const latestEvent = events.at(-1) ?? null
  const elapsedLabel = job ? formatElapsed(now - new Date(job.createdAt).getTime()) : null
  const loadState = getLoadState(projectsQuery.isPending, projectsQuery.isFetching, projectsQuery.isError)
  const domainsError = getFirstMessage([
    domainValidationError,
    domainsQuery.error ? getErrorMessage(domainsQuery.error, "Failed to load docs domains.") : null,
    createDomainMutation.error ? getErrorMessage(createDomainMutation.error, "Failed to add docs domain.") : null,
    refreshDomainMutation.error ? getErrorMessage(refreshDomainMutation.error, "Failed to refresh docs domain.") : null,
  ])

  async function loadDashboard() {
    await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all })
  }

  async function signIn(provider: SignInProvider) {
    await startSignIn(provider, "/dashboard")
  }

  async function createSelectedProject() {
    if (!selectedRepository || createProjectMutation.isPending) return

    await createProjectMutation.mutateAsync({
      githubRepositoryId: selectedRepository.id,
      name: selectedRepository.name,
    }).catch(() => undefined)
  }

  async function addDocsDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProject || createDomainMutation.isPending || !canAddDocsDomain) return

    const hostname = domainHostname.trim()
    if (!hostname) {
      setDomainValidationError("Enter a hostname.")
      return
    }

    setDomainValidationError(null)
    await createDomainMutation.mutateAsync({ projectId: activeProject.id, hostname }).catch(() => undefined)
  }

  async function deleteProjectDomain(domainId: string): Promise<string | null> {
    if (!activeProject) return "Select a project before you delete a domain."
    if (deleteDomainMutation.isPending || refreshDomainMutation.isPending) {
      return "Another domain change is already in progress."
    }

    setDomainValidationError(null)
    try {
      await deleteDomainMutation.mutateAsync({ projectId: activeProject.id, domainId })
      return null
    } catch (error) {
      return getErrorMessage(error, "Failed to delete docs domain.")
    }
  }

  async function refreshProjectDomain(domainId: string) {
    if (!activeProject || refreshDomainMutation.isPending || deleteDomainMutation.isPending) return

    setDomainValidationError(null)
    await refreshDomainMutation.mutateAsync({ projectId: activeProject.id, domainId }).catch(() => undefined)
  }

  async function generateDocs() {
    if (!activeProject || generateDocsMutation.isPending) return

    generateDocsMutation.reset()
    await generateDocsMutation.mutateAsync(activeProject.id).catch(() => undefined)
  }

  return {
    loadState,
    error: projectsQuery.error ? getErrorMessage(projectsQuery.error, "Failed to load dashboard.") : null,
    repositoriesError: repositoriesQuery.data?.error ?? null,
    projects,
    repositories,
    selectedRepositoryId,
    selectedRepository,
    activeProject,
    docsDomains,
    domainsError,
    domainHostname,
    job,
    events,
    actionError: generateDocsMutation.error
      ? getErrorMessage(generateDocsMutation.error, "Failed to start generation.")
      : null,
    isLoadingDomains: Boolean(activeProject) && domainsQuery.isPending,
    isCreatingDomain: createDomainMutation.isPending,
    refreshingDomainId: refreshDomainMutation.isPending ? refreshDomainMutation.variables.domainId : null,
    deletingDomainId: deleteDomainMutation.isPending ? deleteDomainMutation.variables.domainId : null,
    docsUrl,
    generationActive,
    generationButtonLabel,
    jobProgress,
    latestEvent,
    elapsedLabel,
    showLocalInstallCallback: SHOW_LOCAL_INSTALL_CALLBACK,
    loadDashboard,
    signIn,
    setSelectedRepositoryId,
    setActiveProject: (project) => setActiveProjectId(project.id),
    setDomainHostname,
    createSelectedProject,
    addDocsDomain,
    deleteProjectDomain,
    refreshProjectDomain,
    generateDocs,
  }
}

function getLoadState(isPending: boolean, isFetching: boolean, isError: boolean): LoadState {
  if (isPending || isFetching) return "loading"
  if (isError) return "error"
  return "ready"
}

function getFirstMessage(messages: Array<string | null>): string | null {
  return messages.find((message) => message !== null) ?? null
}

function createLocalStartedEvent(job: GenerationJobDto): JobEventDto {
  return {
    id: `${job.id}:local-started`,
    jobId: job.id,
    sequence: LOCAL_STARTED_EVENT_SEQUENCE,
    source: "system",
    type: "request_sent",
    message: "Generation request accepted by the dashboard.",
    data: null,
    createdAt: new Date().toISOString(),
  }
}

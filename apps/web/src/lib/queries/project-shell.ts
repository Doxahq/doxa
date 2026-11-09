import {
  environmentManager,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
} from "@tanstack/react-query"
import {
  projectShellSchema,
  type ProjectShellSectionKey,
} from "@doxahq/contracts/project-shell"

import { getProjectShell } from "~/lib/platform-api"
import { approvalRequestQueryKeys } from "~/lib/queries/approval-requests"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { generationReviewQueryKeys } from "~/lib/queries/generation-review"

/**
 * The project shell request (`GET /projects/:projectId/shell`, see
 * `@doxahq/contracts/project-shell`) loads the project layout's and the
 * Overview's reads in one request, instead of about eight.
 *
 * It does not replace any query. Each of those queries keeps its key, its
 * endpoint, its stale time and its invalidations. Only the first load of a
 * query goes through the shell (see `fromProjectShell`):
 *
 * - The first query that loads starts one shell request. The other queries
 *   that load while it runs wait for it, so no section is requested twice.
 * - Each section with data fills its query, with the time the shell answered,
 *   also for queries that nobody has asked for yet.
 * - A section with an error fills nothing. Its query then calls its own
 *   endpoint, as it did before the shell existed. A failed shell request does
 *   the same for every section.
 * - Every later fetch (a refetch, an invalidation, a retry) calls the
 *   query's own endpoint.
 */

interface ShellSection {
  /** The query that the section fills. */
  queryKey: (projectId: string) => QueryKey
  /** The query's value from the section's data, the same value its own query function returns. */
  toQueryData: (data: unknown) => unknown
}

const SHELL_SECTIONS: Record<ProjectShellSectionKey, ShellSection> = {
  project: {
    queryKey: (projectId) => dashboardQueryKeys.project(projectId),
    toQueryData: (data) => data,
  },
  generationReview: {
    queryKey: (projectId) => generationReviewQueryKeys.project(projectId),
    toQueryData: (data) => (data as { review: unknown }).review,
  },
  pendingMerges: {
    queryKey: (projectId) => dashboardQueryKeys.pendingMerges(projectId),
    toQueryData: (data) => (data as { merges: unknown }).merges,
  },
  doxabot: {
    queryKey: (projectId) => dashboardQueryKeys.doxabot(projectId),
    toQueryData: (data) => (data as { settings: unknown }).settings,
  },
  // An infinite query: the section is its first page.
  generations: {
    queryKey: (projectId) => dashboardQueryKeys.generations(projectId),
    toQueryData: (data) => ({ pages: [data], pageParams: [null] }),
  },
  branches: {
    queryKey: (projectId) => docsBranchQueryKeys.list(projectId),
    toQueryData: (data) => data,
  },
  pendingApprovalRequests: {
    queryKey: (projectId) => approvalRequestQueryKeys.list(projectId, "pending"),
    toQueryData: (data) => data,
  },
  docsDomains: {
    queryKey: (projectId) => dashboardQueryKeys.domains(projectId),
    toQueryData: (data) => data,
  },
  overview: {
    queryKey: (projectId) => dashboardQueryKeys.overview(projectId),
    toQueryData: (data) => data,
  },
}

/** The sections that answered with data, as each endpoint's response body. */
type ShellData = Partial<Record<ProjectShellSectionKey, unknown>>

/** The shell requests in flight, per query client and project. */
const inFlight = new WeakMap<QueryClient, Map<string, Promise<ShellData>>>()

/**
 * Starts the shell request for a project, or returns the one in flight. It
 * never rejects: a failed request gives no sections.
 */
export function loadProjectShell(queryClient: QueryClient, projectId: string): Promise<ShellData> {
  let byProject = inFlight.get(queryClient)
  if (!byProject) {
    byProject = new Map()
    inFlight.set(queryClient, byProject)
  }
  const running = byProject.get(projectId)
  if (running) return running

  const startedAt = Date.now()
  const request = getProjectShell(projectId)
    .then((body) => {
      const sections = readShellSections(body)
      seedShellSections(queryClient, projectId, sections, startedAt, Date.now())
      return sections
    })
    .catch((): ShellData => ({}))
    .finally(() => byProject.delete(projectId))
  byProject.set(projectId, request)
  return request
}

/**
 * The sections of a shell body that have valid data. A section with an
 * error, or with data that does not match the contract, is left out, so its
 * query calls its own endpoint.
 */
export function readShellSections(body: unknown): ShellData {
  if (typeof body !== "object" || body === null) return {}
  const sections: ShellData = {}
  for (const key of Object.keys(SHELL_SECTIONS) as ProjectShellSectionKey[]) {
    const raw = (body as Record<string, unknown>)[key]
    const parsed = projectShellSchema.shape[key].safeParse(raw)
    if (!parsed.success || !("data" in parsed.data)) continue
    // The pending requests endpoint parses its body, so its query holds the
    // parsed value. Every other query holds the body as the API sent it.
    sections[key] = key === "pendingApprovalRequests" ? parsed.data.data : (raw as { data: unknown }).data
  }
  return sections
}

/**
 * Fills each section's query, unless the query got newer data after the
 * shell request started (for example from a save).
 */
function seedShellSections(
  queryClient: QueryClient,
  projectId: string,
  sections: ShellData,
  startedAt: number,
  answeredAt: number,
): void {
  for (const key of Object.keys(sections) as ProjectShellSectionKey[]) {
    const section = SHELL_SECTIONS[key]
    const queryKey = section.queryKey(projectId)
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0
    if (updatedAt > startedAt) continue
    queryClient.setQueryData(queryKey, section.toQueryData(sections[key]), { updatedAt: answeredAt })
  }
}

/**
 * The query function of a shell section's query.
 *
 * The first load of the query takes its data from the shell: it joins the
 * shell request in flight, or starts one. Any other fetch, and a section
 * without data, calls the query's own endpoint with `fetchOwn`.
 */
export async function fromProjectShell<T>(
  context: Pick<QueryFunctionContext, "client" | "queryKey">,
  projectId: string,
  key: ProjectShellSectionKey,
  fetchOwn: () => Promise<T>,
): Promise<T> {
  if (environmentManager.isServer() || !isFirstLoad(context)) return fetchOwn()
  const sections = await loadProjectShell(context.client, projectId)
  if (!(key in sections)) return fetchOwn()
  // The generations query is infinite: its function returns one page.
  if (key === "generations") return sections[key] as T
  return SHELL_SECTIONS[key].toQueryData(sections[key]) as T
}

/**
 * True for the query's first fetch: it has never had data or an error, and
 * this is not a retry. A refetch, an invalidation or a retry is not.
 */
function isFirstLoad({ client, queryKey }: Pick<QueryFunctionContext, "client" | "queryKey">): boolean {
  const state = client.getQueryCache().find({ queryKey, exact: true })?.state
  if (!state) return true
  return state.dataUpdateCount === 0 && state.errorUpdateCount === 0 && state.fetchFailureCount === 0
}

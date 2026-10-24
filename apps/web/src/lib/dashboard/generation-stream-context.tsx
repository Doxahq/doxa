import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import type {
  GenerationJobDto,
  GenerationDetailDto,
  GenerationStreamMessage,
  GenerationsPageDto,
  JobEventDto,
} from "@doxahq/contracts"
import type { InfiniteData } from "@tanstack/react-query"

import {
  appendGenerationEvent,
  createPendingGenerationDetail,
  mergeGenerationDetail,
  mergeGenerationIntoPages,
  mergeLatestJob,
} from "~/lib/dashboard/cache"
import { isTerminalJob } from "~/lib/dashboard/model"
import {
  createGenerationStreamWatchdog,
  GenerationStreamRequestError,
  streamProjectGeneration,
} from "~/lib/generation-stream"
import {
  dashboardQueryKeys,
  type ProjectDetail,
} from "~/lib/queries/dashboard"

export type GenerationStreamStatus = "idle" | "connecting" | "live" | "fallback" | "complete"

interface GenerationStreamState {
  generationId: string | null
  status: GenerationStreamStatus
}

const GenerationStreamContext = createContext<GenerationStreamState>({
  generationId: null,
  status: "idle",
})

export function ProjectGenerationStreamProvider({
  projectId,
  generation,
  children,
}: {
  projectId: string
  generation: GenerationJobDto | null
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<GenerationStreamStatus>("idle")
  const generationId = generation?.id ?? null

  useEffect(() => {
    if (!generation) {
      setStatus("idle")
      return
    }

    if (isTerminalJob(generation)) {
      setStatus("complete")
      return
    }

    if (import.meta.env.VITE_GENERATION_STREAMING_ENABLED === "false") {
      setStatus("fallback")
      return
    }

    const activeGeneration = generation
    const controller = new AbortController()
    let stopped = false
    const watchdog = createGenerationStreamWatchdog(() => {
      if (!stopped) setStatus("fallback")
    })

    async function connect(): Promise<void> {
      let attempt = 0
      let afterSequence = getLatestCachedSequence(queryClient, projectId, activeGeneration.id)

      while (!stopped && !controller.signal.aborted) {
        setStatus(attempt === 0 ? "connecting" : "fallback")
        let completed = false

        try {
          await streamProjectGeneration({
            projectId,
            generationId: activeGeneration.id,
            afterSequence,
            signal: controller.signal,
            callbacks: {
              onMessage: (message, eventId) => {
                if (stopped) return
                watchdog.receivedMessage()
                if (eventId !== null) afterSequence = Math.max(afterSequence, eventId)
                applyStreamMessage(queryClient, projectId, activeGeneration.id, message)
                completed = message.type === "complete"
                setStatus(completed ? "complete" : "live")
              },
            },
          })

          if (completed || stopped) {
            watchdog.stop()
            return
          }
        } catch (error) {
          if (controller.signal.aborted || stopped) return
          if (isPermanentStreamFailure(error)) {
            watchdog.stop()
            setStatus("fallback")
            return
          }
        }

        setStatus("fallback")
        await refreshGenerationQueries(queryClient, projectId, activeGeneration.id)
        attempt += 1
        const continued = await waitForRetry(getRetryDelay(attempt), controller.signal)
        if (!continued) return
      }
    }

    void connect()
    return () => {
      stopped = true
      watchdog.stop()
      controller.abort()
    }
  }, [generation?.id, generation?.status, projectId, queryClient])

  const value = useMemo<GenerationStreamState>(
    () => ({ generationId, status }),
    [generationId, status],
  )

  return (
    <GenerationStreamContext.Provider value={value}>
      {children}
    </GenerationStreamContext.Provider>
  )
}

export function useGenerationStreamStatus(generationId: string | null): GenerationStreamStatus {
  const stream = useContext(GenerationStreamContext)
  return generationId && stream.generationId === generationId ? stream.status : "idle"
}

function applyStreamMessage(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  generationId: string,
  message: GenerationStreamMessage,
): void {
  if (message.type === "event") {
    queryClient.setQueryData<JobEventDto[]>(
      dashboardQueryKeys.generationEvents(projectId, generationId),
      (events) => appendGenerationEvent(events, message.event),
    )
    queryClient.setQueryData<JobEventDto[]>(
      dashboardQueryKeys.events(generationId),
      (events) => appendGenerationEvent(events, message.event),
    )
    return
  }

  if (message.type === "heartbeat") return

  const nextGeneration = message.generation
  queryClient.setQueryData<GenerationDetailDto | undefined>(
    dashboardQueryKeys.generation(projectId, generationId),
    // A stream update must never be dropped. mergeGenerationDetail returns
    // undefined while the first detail fetch is still in flight, and
    // setQueryData discards an undefined result.
    (detail) =>
      mergeGenerationDetail(detail, nextGeneration)
      ?? createPendingGenerationDetail(nextGeneration),
  )
  queryClient.setQueryData(dashboardQueryKeys.job(generationId), nextGeneration)
  queryClient.setQueryData<ProjectDetail | undefined>(
    dashboardQueryKeys.project(projectId),
    (detail) => mergeLatestJob(detail, nextGeneration),
  )
  queryClient.setQueryData<InfiniteData<GenerationsPageDto> | undefined>(
    dashboardQueryKeys.generations(projectId),
    (data) => mergeGenerationIntoPages(data, nextGeneration),
  )

  if (message.type === "complete") {
    void refreshGenerationQueries(queryClient, projectId, generationId)
  }
}

function getLatestCachedSequence(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  generationId: string,
): number {
  const projectEvents = queryClient.getQueryData<JobEventDto[]>(
    dashboardQueryKeys.generationEvents(projectId, generationId),
  )
  const legacyEvents = queryClient.getQueryData<JobEventDto[]>(dashboardQueryKeys.events(generationId))
  return Math.max(0, ...(projectEvents ?? legacyEvents ?? []).map((event) => event.sequence))
}

async function refreshGenerationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  generationId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId), exact: true }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generations(projectId), exact: true }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generation(projectId, generationId), exact: true }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generationEvents(projectId, generationId), exact: true }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects(), exact: true }),
  ])
}

function isPermanentStreamFailure(error: unknown): boolean {
  return error instanceof GenerationStreamRequestError
    && error.status !== null
    && [400, 401, 403, 404].includes(error.status)
}

function getRetryDelay(attempt: number): number {
  const exponentialDelay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5))
  return exponentialDelay + Math.floor(Math.random() * 500)
}

function waitForRetry(durationMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort)
      resolve(true)
    }, durationMs)
    const handleAbort = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", handleAbort, { once: true })
  })
}

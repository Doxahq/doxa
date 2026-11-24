import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { ApiRequestError } from "~/lib/api-errors"
import { getErrorMessage } from "~/lib/errors"
import { refreshRepositories } from "~/lib/platform-api"
import { dashboardQueryKeys, type GitHubRepositoriesResult } from "~/lib/queries/dashboard"

/** The API allows one refresh a minute per installation (`REPOSITORY_REFRESH_COOLDOWN_SECONDS`). */
const REFRESH_COOLDOWN_SECONDS = 60

export interface RepositoryListNotice {
  tone: "info" | "error"
  message: string
}

export interface RepositoryListRefresh {
  refresh: () => void
  isRefreshing: boolean
  /** Seconds until the next refresh can run. 0 when it can run now. */
  secondsLeft: number
  /** What the last refresh said, or null when there is nothing to say. */
  notice: RepositoryListNotice | null
}

/**
 * Reads the repository list from GitHub again, for a repository that Doxa
 * did not get from a webhook. The button waits out the API cooldown, so a
 * click never sends a request that the API refuses.
 */
export function useRefreshGitHubRepositories(): RepositoryListRefresh {
  const queryClient = useQueryClient()
  const [availableAt, setAvailableAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState<RepositoryListNotice | null>(null)

  useEffect(() => {
    if (availableAt <= Date.now()) return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= availableAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [availableAt])

  function waitFor(seconds: number) {
    const current = Date.now()
    setNow(current)
    setAvailableAt(current + seconds * 1000)
  }

  const mutation = useMutation({
    mutationFn: refreshRepositories,
    onMutate: () => setNotice(null),
    onSuccess: (result) => {
      queryClient.setQueryData<GitHubRepositoriesResult>(dashboardQueryKeys.githubRepositories(), {
        repositories: result.repositories,
        error: null,
      })
      waitFor(REFRESH_COOLDOWN_SECONDS)
      if (!result.complete) {
        setNotice({
          tone: "info",
          message: "GitHub returned only part of the list. Refresh again in a minute to get the rest.",
        })
      }
    },
    onError: (error) => {
      const retryAfter = retryAfterSeconds(error)
      if (retryAfter !== null) waitFor(retryAfter)
      // The button counts down a cooldown, so its message adds nothing.
      if (error instanceof ApiRequestError && error.code === "refresh_cooldown") return
      setNotice({ tone: "error", message: getErrorMessage(error, "Doxa could not refresh the list.") })
    },
  })

  return {
    refresh: () => mutation.mutate(),
    isRefreshing: mutation.isPending,
    secondsLeft: Math.max(0, Math.ceil((availableAt - now) / 1000)),
    notice,
  }
}

function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof ApiRequestError)) return null
  const details = error.details
  if (typeof details !== "object" || details === null || !("retryAfterSeconds" in details)) return null
  const seconds = (details as { retryAfterSeconds: unknown }).retryAfterSeconds
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

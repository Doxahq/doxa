import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type {
  BranchRef,
  DocsPublishStage,
  PublishDocsBranchInput,
  PublishDocsBranchResult,
} from "@doxahq/contracts/docs-branches"
import type { ValidationIssue } from "@doxahq/contracts/validation"

import { ApiRequestError, isApiValidationError } from "~/lib/api-errors"
import { useRefreshBranchStatus } from "~/lib/dashboard/use-branch-status"
import { getErrorMessage } from "~/lib/errors"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { publishDocsBranchWithProgress } from "~/lib/docs-branches-api"

/** The server stages of a publish, then "live" once the new version serves. */
export type PublishStep = DocsPublishStage | "live"

export const PUBLISH_STEPS: readonly PublishStep[] = ["preparing", "building", "optimizing", "live"]

/** idle: nothing sent. publishing: the request runs. live / failed: it ended. */
export type PublishPhase = "idle" | "publishing" | "live" | "failed"

export function usePublishBranch(options: {
  projectId: string
  branch: BranchRef
  onPublished: (result: PublishDocsBranchResult) => void
}) {
  const { projectId, branch, onPublished } = options
  const queryClient = useQueryClient()
  const refreshStatus = useRefreshBranchStatus(projectId, branch)
  const [step, setStep] = useState<PublishStep>("preparing")
  const [result, setResult] = useState<PublishDocsBranchResult | null>(null)
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (input: PublishDocsBranchInput) =>
      publishDocsBranchWithProgress(projectId, branch, input, setStep),
    onSuccess: async (result) => {
      setResult(result)
      setStep("live")
      setIssues([])
      setRequestError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.contentRoot(projectId) }),
        queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
      ])
      onPublished(result)
    },
    onError: (error) => {
      refreshStatus(error)
      // The branch changed after the review. Reload it, so the summary shows
      // the new changes and the next publish sends the new revision.
      if (error instanceof ApiRequestError && error.status === 409 && error.code === "conflict") {
        void queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.content(projectId, branch),
        })
      }
      // A page failed the MDX check. Reload the report, so the menu lists it.
      if (error instanceof ApiRequestError && error.code === "mdx_invalid") {
        void queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.contentMdxReport(projectId, branch),
        })
      }
      if (isApiValidationError(error)) {
        setIssues(error.issues)
        setRequestError(null)
        return
      }
      setRequestError(getErrorMessage(error, "The branch could not be published."))
    },
  })

  // The mutation stays pending while `onSuccess` reloads the dashboard data,
  // but the version is live as soon as the result arrives.
  const phase: PublishPhase = result !== null && !mutation.isIdle
    ? "live"
    : mutation.isPending
      ? "publishing"
      : mutation.isError
        ? "failed"
        : "idle"

  return {
    publish: async (input: PublishDocsBranchInput) => {
      setStep("preparing")
      setResult(null)
      setIssues([])
      setRequestError(null)
      await mutation.mutateAsync(input).catch(() => undefined)
    },
    /** Returns to the idle state, for the next publish. */
    reset: () => {
      mutation.reset()
      setStep("preparing")
      setResult(null)
      setIssues([])
      setRequestError(null)
    },
    phase,
    step,
    result,
    errorCode: mutation.error instanceof ApiRequestError ? mutation.error.code : null,
    issues,
    error: requestError,
    isPublishing: mutation.isPending,
  }
}

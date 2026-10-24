import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { SetPageLockInput } from "@doxahq/contracts/generation-reviews"
import { toast } from "sonner"

import { getErrorMessage } from "~/lib/errors"
import { setPageLock } from "~/lib/page-locks-api"
import { pageLockQueryKeys, pageLocksQueryOptions } from "~/lib/queries/page-locks"

/**
 * The pages that a person locked against generations, and the action that
 * locks or unlocks one. Every page is unlocked unless a person locks it.
 */
export function usePageLocks(projectId: string) {
  const queryClient = useQueryClient()
  const query = useQuery(pageLocksQueryOptions(projectId))
  const locked = new Set((query.data ?? []).map((lock) => lock.href))
  const mutation = useMutation({
    mutationFn: (input: SetPageLockInput) => setPageLock(projectId, input),
    onSuccess: (pages, input) => {
      queryClient.setQueryData(pageLockQueryKeys.project(projectId), pages)
      toast.success(
        input.locked
          ? "Locked. Generations keep this page as published."
          : "Unlocked. Generations can update this page when its code changes.",
      )
    },
    onError: (error) => toast.error(getErrorMessage(error, "The page lock could not be saved.")),
  })

  return {
    isLoading: query.isPending,
    isLocked: (href: string) => locked.has(href),
    setLocked: (href: string, isLocked: boolean) => mutation.mutate({ href, locked: isLocked }),
    /** The page whose lock is saving, so only its controls wait. */
    updatingHref: mutation.isPending ? mutation.variables.href : null,
  }
}

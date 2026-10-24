import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AgentActionKind } from "@doxahq/contracts/approval-requests"
import type { ApprovalActionSetting, ApprovalMode } from "@doxahq/contracts/approval-settings"

import { updateProjectApprovalSettings, updateUserApprovalSettings } from "~/lib/approval-settings-api"
import {
  changedFlags,
  changedModes,
  shownFlags,
  shownMode,
  type ApprovalModeDraft,
  type ProjectApprovalFlags,
  type ProjectFlagDraft,
} from "~/lib/dashboard/approval-settings-model"
import { getErrorMessage } from "~/lib/errors"
import {
  approvalSettingsQueryKeys,
  projectApprovalSettingsQueryOptions,
  userApprovalSettingsQueryOptions,
} from "~/lib/queries/approval-settings"

/** The unsaved mode picks of one settings page. */
function useModeDraft() {
  const [draft, setDraft] = useState<ApprovalModeDraft>({})
  return {
    draft,
    modeOf: (setting: ApprovalActionSetting) => shownMode(setting, draft),
    select: (kind: AgentActionKind, mode: ApprovalMode) => setDraft((current) => ({ ...current, [kind]: mode })),
    reset: () => setDraft({}),
  }
}

/** Project settings → Agent approvals: the modes and the project flags. */
export function useProjectApprovalSettings(projectId: string) {
  const queryClient = useQueryClient()
  const query = useQuery(projectApprovalSettingsQueryOptions(projectId))
  const modes = useModeDraft()
  const [flagDraft, setFlagDraft] = useState<ProjectFlagDraft>({})
  const settings = query.data ?? null
  const changes = settings ? changedModes(settings.actions, modes.draft) : {}
  const flagChanges = settings ? changedFlags(settings, flagDraft) : {}
  const flags = shownFlags(settings ?? DEFAULT_FLAGS, flagDraft)
  const isDirty = Object.keys(changes).length > 0 || Object.keys(flagChanges).length > 0

  const save = useMutation({
    mutationFn: () => updateProjectApprovalSettings(projectId, { modes: changes, ...flagChanges }),
    onSuccess: (saved) => {
      queryClient.setQueryData(approvalSettingsQueryKeys.project(projectId), saved)
      modes.reset()
      setFlagDraft({})
    },
  })

  return {
    settings,
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "The approval settings could not be loaded.") : null,
    modeOf: modes.modeOf,
    selectMode: modes.select,
    eraseBranchAfterPublish: flags.eraseBranchAfterPublish,
    setEraseBranchAfterPublish: (value: boolean) => setFlagDraft((draft) => ({ ...draft, eraseBranchAfterPublish: value })),
    requireOtherDecider: flags.requireOtherDecider,
    setRequireOtherDecider: (value: boolean) => setFlagDraft((draft) => ({ ...draft, requireOtherDecider: value })),
    isDirty,
    save: () => save.mutate(),
    isSaving: save.isPending,
    saveError: save.error ? getErrorMessage(save.error, "The approval settings could not be saved.") : null,
  }
}

/** The column defaults, shown until the settings load. */
const DEFAULT_FLAGS: ProjectApprovalFlags = { eraseBranchAfterPublish: true, requireOtherDecider: false }

/** Account settings → Agent approvals: the user's defaults for every project. */
export function useUserApprovalSettings() {
  const queryClient = useQueryClient()
  const query = useQuery(userApprovalSettingsQueryOptions())
  const modes = useModeDraft()
  const settings = query.data ?? null
  const changes = settings ? changedModes(settings.actions, modes.draft) : {}

  const save = useMutation({
    mutationFn: () => updateUserApprovalSettings({ modes: changes }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(approvalSettingsQueryKeys.user(), saved)
      modes.reset()
      // A user default changes the effective mode on every project page.
      await queryClient.invalidateQueries({ queryKey: approvalSettingsQueryKeys.projects() })
    },
  })

  return {
    settings,
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "Your approval settings could not be loaded.") : null,
    modeOf: modes.modeOf,
    selectMode: modes.select,
    isDirty: Object.keys(changes).length > 0,
    save: () => save.mutate(),
    isSaving: save.isPending,
    saveError: save.error ? getErrorMessage(save.error, "Your approval settings could not be saved.") : null,
  }
}

/**
 * The default of the erase checkbox in the approve panel. Undefined while
 * it loads; true when it cannot load, as in v1.
 */
export function useEraseBranchDefault(projectId: string, enabled: boolean): boolean | undefined {
  const query = useQuery({ ...projectApprovalSettingsQueryOptions(projectId), enabled, retry: false })
  if (query.isPending && enabled) return undefined
  return query.data?.eraseBranchAfterPublish ?? true
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import {
  toEditableSiteConfig,
  type EditableSiteConfig,
  type ValidationIssue,
} from "@doxahq/site-config"

import { isApiValidationError } from "~/lib/api-errors"
import { getErrorMessage } from "~/lib/errors"
import {
  activeServerIssues,
  countIssuesByTab,
  hasErrors,
  mergeIssues,
  recordServerIssues,
  type ServerIssueRecord,
  type SettingsIssue,
} from "~/lib/dashboard/site-settings-issues"
import {
  formatSettingsJson,
  parseSettingsJson,
  validateSiteSettings,
  type SiteSettingsContext,
} from "~/lib/dashboard/site-settings-validation"
import { useDraftBuffer, type DraftBufferSource } from "~/lib/dashboard/use-draft-buffer"
import { applyProjectContentEdits } from "~/lib/platform-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

export type SiteSettingsSaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "blocked"; errorCount: number }
  | { kind: "failed"; message: string }

export type CloseRequest = "close" | "confirm" | "stay"

interface UseSiteSettingsOptions {
  projectId: string
  branch: BranchRef
  overview: DocsContentOverviewDto
  /** Issues the API returned for a publish, shown as soon as the dialog opens. */
  initialServerIssues?: readonly ValidationIssue[]
}

/**
 * The state of the site settings dialog.
 *
 * The form and the JSON tab edit one config in one working buffer. Every rule
 * that can run in the browser runs on each change. The server repeats the
 * shared rules and adds its own, and its issues stay until the value changes.
 */
export function useSiteSettings({
  projectId,
  branch,
  overview,
  initialServerIssues = [],
}: UseSiteSettingsOptions) {
  const queryClient = useQueryClient()
  const [source, setSource] = useState<DraftBufferSource<EditableSiteConfig>>(() => ({
    key: "site-config",
    value: toEditableSiteConfig(overview.siteConfig.working ?? overview.siteConfig.published),
  }))
  const [serverRecords, setServerRecords] = useState<ServerIssueRecord[]>(() =>
    recordServerIssues(initialServerIssues, source.value),
  )
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const [saveAttempted, setSaveAttempted] = useState(initialServerIssues.length > 0)
  const [isSaving, setIsSaving] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [jsonText, setJsonTextState] = useState(() => formatSettingsJson(source.value))
  const [jsonIssues, setJsonIssues] = useState<readonly ValidationIssue[]>([])

  const invalidateBranchQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.content(projectId, branch),
    })
    void queryClient.invalidateQueries({
      queryKey: docsBranchQueryKeys.status(projectId, branch),
    })
    void queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) })
  }, [branch, projectId, queryClient])

  const context = useMemo<SiteSettingsContext>(
    () => ({ pageHrefs: overview.pages.map((page) => page.href), entitlements: overview.entitlements }),
    [overview.entitlements, overview.pages],
  )

  const buffer = useDraftBuffer<EditableSiteConfig>({
    source,
    isEqual: sameSiteConfig,
    canSave: (value) => jsonIssues.length === 0 && !hasErrors(validateSiteSettings(value, context)),
    save: async (config) => {
      setIsSaving(true)
      try {
        await applyProjectContentEdits(projectId, {
          branch,
          edits: [{ type: "set_site_config", config }],
        })
      } catch (error) {
        if (isApiValidationError(error)) {
          setServerRecords(recordServerIssues(error.issues, config))
          setSaveAttempted(true)
          setRequestError(null)
        } else {
          setRequestError(getErrorMessage(error, "The settings could not be saved."))
        }
        throw error
      } finally {
        setIsSaving(false)
      }
      setServerRecords([])
      setRequestError(null)
      invalidateBranchQueries()
    },
  })

  const config = buffer.value ?? source.value
  const { setValue, update } = buffer

  // The JSON text follows every change that did not come from the JSON tab.
  // A change typed in the JSON tab keeps the text exactly as typed.
  const configFromJsonRef = useRef<EditableSiteConfig | null>(null)
  useEffect(() => {
    if (config === configFromJsonRef.current) return
    setJsonTextState(formatSettingsJson(config))
    setJsonIssues([])
  }, [config])

  const setJsonText = useCallback(
    (text: string) => {
      setJsonTextState(text)
      const parsed = parseSettingsJson(text)
      if (!parsed.ok) {
        setJsonIssues(parsed.issues)
        return
      }
      setJsonIssues([])
      configFromJsonRef.current = parsed.config
      setValue(parsed.config)
    },
    [setValue],
  )

  const clientIssues = useMemo(() => validateSiteSettings(config, context), [config, context])
  const serverIssues = useMemo(() => activeServerIssues(serverRecords, config), [config, serverRecords])
  const issues = useMemo<SettingsIssue[]>(
    () => mergeIssues([...jsonIssues, ...clientIssues], serverIssues),
    [clientIssues, jsonIssues, serverIssues],
  )
  const tabCounts = useMemo(() => countIssuesByTab(issues), [issues])
  const errorCount = issues.filter((issue) => issue.severity === "error").length
  const canSave = errorCount === 0

  /** Issues for the JSON editor lint: the text's own problems, or the config's. */
  const diagnoseJson = useCallback(
    (text: string): readonly ValidationIssue[] => {
      const parsed = parseSettingsJson(text)
      if (!parsed.ok) return parsed.issues
      return mergeIssues(
        validateSiteSettings(parsed.config, context),
        activeServerIssues(serverRecords, parsed.config),
      )
    },
    [context, serverRecords],
  )

  const markTouched = useCallback((pointer: string) => {
    setTouched((current) => (current.has(pointer) ? current : new Set(current).add(pointer)))
  }, [])

  /** An inline field message waits for the first blur or the first save attempt. */
  const isIssueVisible = useCallback(
    (issue: SettingsIssue) => saveAttempted || issue.source === "server" || touched.has(issue.path),
    [saveAttempted, touched],
  )

  /** An explicit save: `Cmd+S`, or a close with valid changes. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    setSaveAttempted(true)
    if (!canSave) return false
    return buffer.flush()
  }, [buffer, canSave])

  /**
   * Decides what a close does. Valid changes are saved first. Changes that
   * cannot be saved need a confirmation, because closing drops them.
   */
  const requestClose = useCallback(async (): Promise<CloseRequest> => {
    if (!buffer.isDirty && jsonIssues.length === 0) return "close"
    if (!canSave) {
      setSaveAttempted(true)
      return "confirm"
    }
    return (await buffer.flush()) ? "close" : "stay"
  }, [buffer, canSave, jsonIssues.length])

  /** Starts a fresh buffer from a config the working branch now holds. */
  const replaceConfig = useCallback(
    (value: EditableSiteConfig, key: string) => {
      configFromJsonRef.current = null
      buffer.reset()
      setSource({ key: `site-config:${key}:${Date.now()}`, value })
      setServerRecords([])
      setTouched(new Set())
      setSaveAttempted(false)
      setRequestError(null)
      invalidateBranchQueries()
    },
    [buffer, invalidateBranchQueries],
  )

  const resetToPublished = useCallback(async (): Promise<boolean> => {
    buffer.cancelAutosave()
    try {
      await applyProjectContentEdits(projectId, {
        branch,
        edits: [{ type: "reset_site_config" }],
      })
    } catch (error) {
      setRequestError(getErrorMessage(error, "The settings could not be reset."))
      return false
    }
    replaceConfig(toEditableSiteConfig(overview.siteConfig.published), "reset")
    return true
  }, [branch, buffer, overview.siteConfig.published, projectId, replaceConfig])

  /**
   * Writes the default settings to the working branch. Unsaved edits are
   * replaced. Nothing is published: the defaults go live with the next publish.
   */
  const restoreDefaults = useCallback(
    async (defaults: EditableSiteConfig): Promise<boolean> => {
      buffer.cancelAutosave()
      // A save that is still running must not land after the defaults.
      await buffer.waitForPendingSaves()
      try {
        await applyProjectContentEdits(projectId, {
          branch,
          edits: [{ type: "set_site_config", config: defaults }],
        })
      } catch (error) {
        setRequestError(getErrorMessage(error, "The default settings could not be restored."))
        return false
      }
      replaceConfig(defaults, "defaults")
      return true
    },
    [branch, buffer, projectId, replaceConfig],
  )

  const status: SiteSettingsSaveStatus = requestError
    ? { kind: "failed", message: requestError }
    : isSaving
      ? { kind: "saving" }
      : (buffer.isDirty || jsonIssues.length > 0) && !canSave
        ? { kind: "blocked", errorCount }
        : buffer.isDirty
          ? { kind: "pending" }
          : overview.siteConfig.working !== null
            ? { kind: "saved" }
            : { kind: "idle" }

  return {
    config,
    update,
    issues,
    tabCounts,
    errorCount,
    isIssueVisible,
    markTouched,
    jsonText,
    setJsonText,
    diagnoseJson,
    saveNow,
    requestClose,
    resetToPublished,
    restoreDefaults,
    hasWorkingConfig: overview.siteConfig.working !== null,
    status,
    entitlements: overview.entitlements,
    pageHrefs: context.pageHrefs,
    pages: overview.pages,
    navigation: overview.navigation,
  }
}

export type SiteSettingsState = ReturnType<typeof useSiteSettings>

/** Configs are plain JSON data, so equal JSON means equal settings. */
export function sameSiteConfig(left: EditableSiteConfig, right: EditableSiteConfig): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

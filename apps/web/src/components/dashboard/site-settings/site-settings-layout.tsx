import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react"
import { useQuery } from "@tanstack/react-query"
import { Outlet, useBlocker, useNavigate } from "@tanstack/react-router"
import { AlertCircle, Loader2, RotateCcw } from "lucide-react"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { toast } from "sonner"

import { IssueSummary } from "~/components/dashboard/content/site-settings/site-settings-issue-summary"
import { SiteSettingsProvider } from "~/components/dashboard/content/site-settings/site-settings-context"
import type { JsonRevealRequest } from "~/components/dashboard/content/site-settings/tabs/json-tab"
import { PageBody } from "~/components/dashboard/dashboard-header"
import {
  SITE_SETTINGS_SECTIONS,
  siteSettingsSectionLabel,
  type SiteSettingsSection,
} from "~/components/dashboard/shell/site-settings-sidebar-view"
import { MoreMenu, MoreMenuLabel, SiteMenuItems, TopBar } from "~/components/dashboard/shell/top-bar"
import { SiteSettingsPublishMenu } from "~/components/dashboard/site-settings/site-settings-publish-menu"
import { SiteSettingsSaveStatus } from "~/components/dashboard/site-settings/site-settings-save-status"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/dropdown-menu"
import { SiteSettingsPending } from "~/components/dashboard/skeletons/site-settings-skeletons"
import { TooltipProvider } from "~/components/ui/tooltip"
import { useProjectBranch } from "~/lib/dashboard/project-branch-context"
import { defaultSiteSettings } from "~/lib/dashboard/site-settings-edits"
import {
  fieldIdForPointer,
  tabForIssue,
  type SettingsIssue,
  type SiteSettingsTab,
} from "~/lib/dashboard/site-settings-issues"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import { sameSiteConfig, useSiteSettings } from "~/lib/dashboard/use-site-settings"
import { getErrorMessage } from "~/lib/errors"
import { projectContentQueryOptions, projectDetailQueryOptions } from "~/lib/queries/dashboard"
import { cn } from "~/lib/utils"

const NO_SERVER_ISSUES = [] as const

/** The dialog tabs, now grouped into sidebar sections. */
const SECTION_FOR_TAB: Record<SiteSettingsTab, SiteSettingsSection> = {
  branding: "appearance",
  theme: "appearance",
  navbar: "navigation",
  footer: "navigation",
  seo: "seo",
  features: "features",
  json: "advanced",
}

interface SiteSettingsPageContextValue {
  reveal: JsonRevealRequest | null
}

const SiteSettingsPageContext = createContext<SiteSettingsPageContextValue>({ reveal: null })

/** The JSON location the Advanced page must reveal, set by the issue summary. */
export function useSiteSettingsReveal(): JsonRevealRequest | null {
  return useContext(SiteSettingsPageContext).reveal
}

export function sectionFromPath(pathname: string): SiteSettingsSection {
  const segment = /\/site\/([^/]+)/.exec(pathname)?.[1]
  return SITE_SETTINGS_SECTIONS.find((section) => section === segment) ?? "appearance"
}

/**
 * The site settings area. Every section shares one settings state, so moving
 * between sections keeps unsaved edits. The state reads the branch that is
 * open in the editor, the same as the settings dialog did.
 */
export function SiteSettingsLayout({ projectId }: { projectId: string }) {
  const branch = useProjectBranch()
  const pathname = useRenderedPathname()
  const section = sectionFromPath(pathname)
  const content = useQuery(projectContentQueryOptions(projectId, branch.branchRef))
  const crumbs = ["Site settings", siteSettingsSectionLabel(section)]

  if (content.data) {
    return (
      <SiteSettingsWorkspace
        key={branch.branchRef}
        projectId={projectId}
        branch={branch.branchRef}
        overview={content.data}
        section={section}
        crumbs={crumbs}
      />
    )
  }

  // Domains do not depend on the site config, so they stay usable before the
  // first generation.
  return (
    <>
      <TopBar
        crumbs={crumbs}
        menu={
          <MoreMenu>
            <SiteMenuItems projectId={projectId} />
          </MoreMenu>
        }
      />
      {/* The same skeleton as the route's pending view, so a visit shows one loading state. */}
      {section !== "domains" && content.isPending ? (
        <SiteSettingsPending />
      ) : (
        <PageBody className="max-w-4xl">
          {section === "domains" ? (
            <Outlet />
          ) : (
            <Alert>
              <AlertCircle aria-hidden="true" />
              <AlertDescription>
                {getErrorMessage(content.error, "Generate documentation first. Site settings apply to a published site.")}
              </AlertDescription>
            </Alert>
          )}
        </PageBody>
      )}
    </>
  )
}

function SiteSettingsWorkspace({
  projectId,
  branch,
  overview,
  section,
  crumbs,
}: {
  projectId: string
  branch: BranchRef
  overview: DocsContentOverviewDto
  section: SiteSettingsSection
  crumbs: string[]
}) {
  const navigate = useNavigate()
  const state = useSiteSettings({ projectId, branch, overview, initialServerIssues: NO_SERVER_ISSUES })
  const capabilities = useProjectCapabilities(projectId)
  const readOnly = !capabilities.can("site.write")
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const [reveal, setReveal] = useState<JsonRevealRequest | null>(null)
  const [isConfirmingReset, setIsConfirmingReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [isConfirmingRestore, setIsConfirmingRestore] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const projectName = useQuery(projectDetailQueryOptions(projectId)).data?.project.name
  const defaults = useMemo(
    () => (projectName === undefined ? null : defaultSiteSettings(projectName)),
    [projectName],
  )
  const isDefault = defaults !== null && sameSiteConfig(state.config, defaults)
  const visibleIssues = state.issues.filter(state.isIssueVisible)
  const base = `/dashboard/projects/${projectId}/site`

  // Leaving the site settings area saves first, the same as "Done" in the
  // dialog. If errors keep the settings from saving, the person decides.
  const blocker = useBlocker({
    shouldBlockFn: async ({ next }) => {
      if (next.pathname.startsWith(base)) return false
      return (await state.requestClose()) !== "close"
    },
    enableBeforeUnload: () => state.status.kind !== "idle" && state.status.kind !== "saved",
    withResolver: true,
  })

  // Focus moves after the target section has rendered its fields.
  useEffect(() => {
    if (!pendingFocus || section === "advanced") return
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(fieldIdForPointer(pendingFocus))
      element?.scrollIntoView({ block: "center" })
      element?.focus()
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus, section])

  function goToIssue(issue: SettingsIssue) {
    const tab = tabForIssue(issue)
    void navigate({
      to: `/dashboard/projects/$projectId/site/${SECTION_FOR_TAB[tab]}`,
      params: { projectId },
    })
    if (tab === "json") {
      setReveal({
        pointer: issue.path,
        target: issue.code === "unknown_key" ? "key" : "value",
        id: Date.now(),
      })
    } else {
      setPendingFocus(issue.path)
    }
  }

  async function reset() {
    setIsResetting(true)
    const done = await state.resetToPublished()
    setIsResetting(false)
    if (done) setIsConfirmingReset(false)
  }

  async function restore() {
    if (!defaults) return
    setIsRestoring(true)
    const done = await state.restoreDefaults(defaults)
    setIsRestoring(false)
    if (done) {
      setIsConfirmingRestore(false)
      toast.success("Default settings restored")
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // CodeMirror handles Mod-s itself inside the JSON editor.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      if (!readOnly) void state.saveNow()
    }
  }

  return (
    <SiteSettingsProvider projectId={projectId} state={state} readOnly={readOnly}>
      <SiteSettingsPageContext.Provider value={{ reveal }}>
        <TopBar
          crumbs={crumbs}
          status={<SiteSettingsSaveStatus status={state.status} className="truncate text-[13px] max-[820px]:hidden" />}
          actions={
            <>
              {readOnly ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsConfirmingReset(true)}
                  disabled={!state.hasWorkingConfig}
                  title={state.hasWorkingConfig ? undefined : "The settings match the published version."}
                >
                  Reset to published
                </Button>
              )}
              {capabilities.can("docs.publish") ? (
                <SiteSettingsPublishMenu projectId={projectId} overview={overview} state={state} />
              ) : null}
            </>
          }
          menu={
            <MoreMenu>
              <SiteMenuItems projectId={projectId} />
              {readOnly ? null : (
                <>
                  <DropdownMenuSeparator className="my-1.5 bg-divider" />
                  <MoreMenuLabel>Settings</MoreMenuLabel>
                  <DropdownMenuItem
                    disabled={!defaults || isDefault || isRestoring}
                    onSelect={() => setIsConfirmingRestore(true)}
                    className="text-danger focus:text-danger [&_svg]:text-danger"
                  >
                    <RotateCcw aria-hidden="true" />
                    Restore default settings
                  </DropdownMenuItem>
                </>
              )}
            </MoreMenu>
          }
        />

        <ConfirmDialog
          open={blocker.status === "blocked"}
          title="Leave without saving?"
          description="Some settings have errors and are not saved. If you leave, these changes are lost."
          cancelLabel="Keep editing"
          confirmLabel="Leave without saving"
          onCancel={() => blocker.reset?.()}
          onConfirm={() => blocker.proceed?.()}
        />
        <ConfirmDialog
          open={isConfirmingReset && blocker.status !== "blocked"}
          title="Reset to published?"
          description="Every setting goes back to the published version. Unpublished setting changes are lost."
          cancelLabel="Cancel"
          confirmLabel="Reset settings"
          pending={isResetting}
          onCancel={() => setIsConfirmingReset(false)}
          onConfirm={() => void reset()}
        />
        <ConfirmDialog
          open={isConfirmingRestore && blocker.status !== "blocked"}
          title="Restore default settings?"
          description="Every site setting on this branch goes back to its default value. Your logo, theme, links, and other customizations are removed. Pages and domains do not change, and nothing is published."
          cancelLabel="Cancel"
          confirmLabel="Restore defaults"
          pending={isRestoring}
          onCancel={() => setIsConfirmingRestore(false)}
          onConfirm={() => void restore()}
        />

        <TooltipProvider delayDuration={200}>
          <div onKeyDown={onKeyDown} className="flex flex-1 flex-col">
            {/* The JSON editor uses the full page height. */}
            <PageBody className={cn("max-w-4xl", section === "advanced" && "flex-1")}>
              {visibleIssues.length > 0 ? (
                <IssueSummary
                  issues={visibleIssues}
                  forceOpen={blocker.status === "blocked"}
                  onNavigate={goToIssue}
                />
              ) : null}
              {readOnly ? <ReadOnlySettings section={section} /> : <Outlet />}
            </PageBody>
          </div>
        </TooltipProvider>
      </SiteSettingsPageContext.Provider>
    </SiteSettingsProvider>
  )
}

/**
 * The settings for a role without `site.write`. A disabled fieldset turns off
 * every native control inside it; the JSON editor and the logo drop zones read
 * `readOnly` from the context. The Domains section has its own role check.
 */
function ReadOnlySettings({ section }: { section: SiteSettingsSection }) {
  if (section === "domains") return <Outlet />
  return (
    <>
      <p className="text-sm text-muted-foreground">
        You can view the site settings. Your role in this project cannot change them.
      </p>
      <fieldset disabled className="contents">
        <Outlet />
      </fieldset>
    </>
  )
}

/**
 * A question in a dialog, with two answers. A dialog does not move the page,
 * and it keeps the question and its result together.
 */
function ConfirmDialog({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  pending = false,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  pending?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onCancel()
      }}
    >
      <DialogContent
        role="alertdialog"
        className="shadow-none sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-balance">{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription className="text-pretty">{description}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

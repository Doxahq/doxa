import { lazy, Suspense, useEffect, useState, type KeyboardEvent, type ReactNode } from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { Loader2 } from "lucide-react"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import type { ValidationIssue } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { TooltipProvider } from "~/components/ui/tooltip"
import { IssueSummary } from "~/components/dashboard/content/site-settings/site-settings-issue-summary"
import { SiteSettingsProvider } from "~/components/dashboard/content/site-settings/site-settings-context"
import { BrandingTab } from "~/components/dashboard/content/site-settings/tabs/branding-tab"
import { FeaturesTab } from "~/components/dashboard/content/site-settings/tabs/features-tab"
import { FooterTab } from "~/components/dashboard/content/site-settings/tabs/footer-tab"
import type { JsonRevealRequest } from "~/components/dashboard/content/site-settings/tabs/json-tab"
import { NavbarTab } from "~/components/dashboard/content/site-settings/tabs/navbar-tab"
import { SeoTab } from "~/components/dashboard/content/site-settings/tabs/seo-tab"
import { ThemeTab } from "~/components/dashboard/content/site-settings/tabs/theme-tab"
import {
  fieldIdForPointer,
  SITE_SETTINGS_TAB_LABELS,
  SITE_SETTINGS_TABS,
  tabForIssue,
  type SettingsIssue,
  type SiteSettingsTab,
} from "~/lib/dashboard/site-settings-issues"
import {
  useSiteSettings,
  type SiteSettingsState,
} from "~/lib/dashboard/use-site-settings"
import { SiteSettingsSaveStatus } from "~/components/dashboard/site-settings/site-settings-save-status"
import { useDialogFocusReturn } from "~/lib/dashboard/use-dialog-focus-return"
import { cn } from "~/lib/utils"

// The JSON tab carries CodeMirror and the JSON language. It loads only when
// a person opens the tab.
const JsonTab = lazy(() => import("~/components/dashboard/content/site-settings/tabs/json-tab"))

const TAB_CONTENT: Record<Exclude<SiteSettingsTab, "json">, () => ReactNode> = {
  branding: () => <BrandingTab />,
  theme: () => <ThemeTab />,
  navbar: () => <NavbarTab />,
  footer: () => <FooterTab />,
  seo: () => <SeoTab />,
  features: () => <FeaturesTab />,
}

type FooterMode = "default" | "confirm-close" | "confirm-reset"

export interface SiteSettingsDialogProps {
  projectId: string
  branch: BranchRef
  overview: DocsContentOverviewDto
  /** Issues from a rejected publish. The dialog opens on the first one. */
  initialServerIssues?: readonly ValidationIssue[]
  onClose: () => void
}

/**
 * The site settings of one docs site: form tabs and a raw JSON tab.
 *
 * Mount it only while it is open. Each open reads the current branch, so a
 * closed dialog never holds stale settings.
 */
export default function SiteSettingsDialog({
  projectId,
  branch,
  overview,
  initialServerIssues = [],
  onClose,
}: SiteSettingsDialogProps) {
  const state = useSiteSettings({ projectId, branch, overview, initialServerIssues })
  const focusReturn = useDialogFocusReturn()
  const firstIssue = initialServerIssues[0]
  const [activeTab, setActiveTab] = useState<SiteSettingsTab>(
    firstIssue ? tabForIssue(firstIssue) : "branding",
  )
  const [pendingFocus, setPendingFocus] = useState<string | null>(firstIssue?.path ?? null)
  const [reveal, setReveal] = useState<JsonRevealRequest | null>(null)
  const [footerMode, setFooterMode] = useState<FooterMode>("default")
  const [isClosing, setIsClosing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // The summary follows the same rule as the field messages: nothing about a
  // field the person has not left yet. The footer still says why a save waits.
  const visibleIssues = state.issues.filter(state.isIssueVisible)

  // The close question is only true while errors block the save. Once the
  // person corrects them, the normal footer and its save status come back.
  const errorCount = state.errorCount
  useEffect(() => {
    if (errorCount === 0) setFooterMode((mode) => (mode === "confirm-close" ? "default" : mode))
  }, [errorCount])

  // Focus moves after the target tab has rendered its fields.
  useEffect(() => {
    if (!pendingFocus || activeTab === "json") return
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(fieldIdForPointer(pendingFocus))
      element?.scrollIntoView({ block: "center" })
      element?.focus()
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeTab, pendingFocus])

  function navigateTo(issue: SettingsIssue) {
    const tab = tabForIssue(issue)
    setActiveTab(tab)
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

  async function requestClose() {
    if (isClosing) return
    setIsClosing(true)
    const decision = await state.requestClose()
    setIsClosing(false)
    if (decision === "close") onClose()
    else if (decision === "confirm") setFooterMode("confirm-close")
  }

  async function reset() {
    setIsResetting(true)
    const done = await state.resetToPublished()
    setIsResetting(false)
    if (done) setFooterMode("default")
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // CodeMirror handles Mod-s itself inside the JSON editor.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      void state.saveNow()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : void requestClose())}>
      <DialogContent
        {...focusReturn}
        // The dialog renders in a portal, outside the dashboard shell that sets
        // the sans font. Forms read in Inter, as in the rest of the dashboard.
        // The size follows the viewport, so large screens get room for the
        // forms, the theme preview and the JSON editor.
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[112rem] flex-col font-sans md:h-[88dvh] md:w-[85vw]"
        onKeyDown={onKeyDown}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Site settings</DialogTitle>
          <DialogDescription>
            Changes save automatically. Publish them to make them live.
          </DialogDescription>
        </DialogHeader>

        <SiteSettingsProvider projectId={projectId} state={state}>
          <TooltipProvider delayDuration={200}>
            <TabsPrimitive.Root
              value={activeTab}
              onValueChange={(value) => {
                const tab = SITE_SETTINGS_TABS.find((candidate) => candidate === value)
                if (tab) setActiveTab(tab)
              }}
              orientation="vertical"
              className="flex min-h-0 flex-1 flex-col md:flex-row"
            >
              <TabList state={state} />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {visibleIssues.length > 0 ? (
                  <div className="shrink-0 px-6 pt-4">
                    <IssueSummary
                      issues={visibleIssues}
                      defaultOpen={initialServerIssues.length > 0}
                      forceOpen={footerMode === "confirm-close"}
                      onNavigate={navigateTo}
                    />
                  </div>
                ) : null}
                {SITE_SETTINGS_TABS.map((tab) => (
                  <TabsPrimitive.Content
                    key={tab}
                    value={tab}
                    // The gutter keeps room for the scrollbar on every tab, so
                    // the content does not move between a short and a long tab.
                    className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-6 py-5 outline-none [scrollbar-gutter:stable] data-[state=inactive]:hidden"
                  >
                    {tab === "json" ? (
                      <Suspense fallback={<TabFallback />}>
                        <JsonTab reveal={reveal} />
                      </Suspense>
                    ) : (
                      TAB_CONTENT[tab]()
                    )}
                  </TabsPrimitive.Content>
                ))}
              </div>
            </TabsPrimitive.Root>
          </TooltipProvider>
        </SiteSettingsProvider>

        <DialogFooter className="shrink-0 items-center sm:justify-between">
          {footerMode === "confirm-close" ? (
            <>
              <p className="text-sm text-destructive">
                Some settings have errors and are not saved. Close and lose these changes?
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setFooterMode("default")}>
                  Keep editing
                </Button>
                <Button type="button" variant="destructive" onClick={onClose}>
                  Close without saving
                </Button>
              </div>
            </>
          ) : footerMode === "confirm-reset" ? (
            <>
              <p className="text-sm text-foreground">
                Reset every setting to the published version? Unpublished setting changes are lost.
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setFooterMode("default")} disabled={isResetting}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" onClick={() => void reset()} disabled={isResetting}>
                  {isResetting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                  Reset settings
                </Button>
              </div>
            </>
          ) : (
            <>
              <SiteSettingsSaveStatus status={state.status} />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFooterMode("confirm-reset")}
                  disabled={!state.hasWorkingConfig}
                  title={state.hasWorkingConfig ? undefined : "The settings match the published version."}
                >
                  Reset to published
                </Button>
                <Button type="button" onClick={() => void requestClose()} disabled={isClosing}>
                  {isClosing ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                  Done
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TabList({ state }: { state: SiteSettingsState }) {
  return (
    <TabsPrimitive.List
      aria-label="Settings sections"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-2 md:w-48 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:px-2 md:py-4"
    >
      {SITE_SETTINGS_TABS.map((tab) => {
        const { errors, warnings } = state.tabCounts[tab]
        const label = SITE_SETTINGS_TAB_LABELS[tab]
        const summary = [
          errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : null,
          warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
        ].filter(Boolean)
        return (
          <TabsPrimitive.Trigger
            key={tab}
            value={tab}
            aria-label={summary.length > 0 ? `${label}, ${summary.join(", ")}` : label}
            className={cn(
              "flex shrink-0 items-center justify-between gap-3 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:-outline-offset-2",
              "data-[state=active]:text-primary",
              tab === "json" && "font-mono text-xs tracking-[0.08em] md:mt-auto",
            )}
          >
            <span>{label}</span>
            {errors > 0 ? (
              <span aria-hidden="true" className="min-w-5 bg-destructive px-1.5 py-0.5 text-center font-mono text-[10px] leading-none text-destructive-foreground">
                {errors}
              </span>
            ) : warnings > 0 ? (
              <span aria-hidden="true" className="size-1.5 bg-warning" />
            ) : null}
          </TabsPrimitive.Trigger>
        )
      })}
    </TabsPrimitive.List>
  )
}

function TabFallback() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      <span className="font-mono text-[10px] tracking-[0.14em] uppercase">Loading editor</span>
    </div>
  )
}

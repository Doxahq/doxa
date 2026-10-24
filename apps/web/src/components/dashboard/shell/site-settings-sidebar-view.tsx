import type { ComponentType, ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Braces, Globe2, List, Palette, Search, ToggleRight } from "lucide-react"

import {
  SidebarNavHint,
  SidebarNavLink,
  SidebarSectionLabel,
} from "~/components/dashboard/shell/sidebar-nav"
import { SidebarViewFooter, SidebarViewHeader } from "~/components/dashboard/shell/sidebar-view-stack"
import { getDocsDomainStatus } from "~/lib/dashboard/domain-status"
import { isProjectPublished } from "~/lib/dashboard/model"
import { projectMonogram } from "~/lib/dashboard/project-monogram"
import { useOptionalProjectBranch } from "~/lib/dashboard/project-branch-context"
import { useShell } from "~/lib/dashboard/shell-context"
import { usePageSettled } from "~/lib/dashboard/use-page-settled"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import {
  docsDomainsQueryOptions,
  projectContentQueryOptions,
  projectDetailQueryOptions,
} from "~/lib/queries/dashboard"

/** The site settings sections, in sidebar order. */
export const SITE_SETTINGS_SECTIONS = [
  "appearance",
  "navigation",
  "domains",
  "seo",
  "features",
  "advanced",
] as const
export type SiteSettingsSection = (typeof SITE_SETTINGS_SECTIONS)[number]

const SECTION_ITEMS: Record<SiteSettingsSection, { label: string; icon: ComponentType<{ className?: string }> }> = {
  appearance: { label: "Appearance", icon: Palette },
  navigation: { label: "Navigation", icon: List },
  domains: { label: "Domains", icon: Globe2 },
  seo: { label: "SEO & sharing", icon: Search },
  features: { label: "Features", icon: ToggleRight },
  advanced: { label: "Advanced (JSON)", icon: Braces },
}

export function siteSettingsSectionLabel(section: SiteSettingsSection): string {
  return SECTION_ITEMS[section].label
}

/** The Site settings sidebar view: site card, sections with their current values, and a note. */
export function SiteSettingsSidebarView({ projectId }: { projectId: string }) {
  const pathname = useRenderedPathname()
  const { closeSiteSettings, view } = useShell()
  const branch = useOptionalProjectBranch()
  const detail = useQuery(projectDetailQueryOptions(projectId))
  const project = detail.data?.project ?? null
  const isPublished = project ? isProjectPublished(project) : false
  // The view is hidden until site settings open, so its requests wait until
  // the page settles. When the view shows, they start at once.
  const isSettled = usePageSettled()
  const isNeeded = isSettled || view === "site"
  const content = useQuery({
    ...projectContentQueryOptions(projectId, branch?.branchRef ?? "main"),
    enabled: isPublished && branch !== null && isNeeded,
  })
  const domains = useQuery({ ...docsDomainsQueryOptions(projectId), enabled: isNeeded })
  const config = content.data?.siteConfig.working ?? content.data?.siteConfig.published ?? null
  const readyDomain = domains.data?.domains.find(
    (domain) => getDocsDomainStatus(domain).overall.label === "Ready",
  )
  const liveHost = readyDomain?.hostname ?? hostOf(isPublished ? project?.docsUrl : null)
  const siteName = config?.name ?? project?.name ?? "Docs site"
  // The site card takes the project's monogram fill, never the site's accent:
  // the dashboard keeps its own colors whatever theme the site sets.
  const monogramColor = project ? projectMonogram(project).color : "var(--monogram-0)"
  const base = `/dashboard/projects/${projectId}/site`

  const values: Record<SiteSettingsSection, ReactNode> = {
    appearance: config ? (
      <SidebarNavHint>{config.theme.defaultMode}</SidebarNavHint>
    ) : null,
    navigation: config ? (
      <SidebarNavHint>{plural(config.navbar.links.length, "link")}</SidebarNavHint>
    ) : null,
    domains: isPublished ? (
      <SidebarNavHint>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        live
      </SidebarNavHint>
    ) : (
      <SidebarNavHint>not live</SidebarNavHint>
    ),
    seo: config ? <SidebarNavHint>{plural(config.seo.keywords.length, "keyword")}</SidebarNavHint> : null,
    features: null,
    advanced: null,
  }

  return (
    <>
      <SidebarViewHeader
        label="Site settings"
        backLabel="Back (Esc)"
        onBack={() => closeSiteSettings(projectId)}
      >
        <div className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-2.5 rounded-lg border border-border bg-card p-2.5">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center font-mono text-sm font-bold text-foreground"
            style={{ backgroundColor: monogramColor }}
          >
            {siteName.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-foreground">{siteName}</span>
            <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
              {liveHost ? (
                <>
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
                  {liveHost}
                </>
              ) : (
                "Not published yet"
              )}
            </span>
          </span>
        </div>
      </SidebarViewHeader>

      <nav aria-label="Site settings" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3.5">
        <SidebarSectionLabel>Site</SidebarSectionLabel>
        {SITE_SETTINGS_SECTIONS.map((section) => (
          <SidebarNavLink
            key={section}
            to={`/dashboard/projects/$projectId/site/${section}`}
            params={{ projectId }}
            icon={SECTION_ITEMS[section].icon}
            label={SECTION_ITEMS[section].label}
            active={pathname === `${base}/${section}`}
            hint={values[section]}
          />
        ))}
      </nav>

      <SidebarViewFooter>
        <p className="px-1 pt-1 pb-2 text-xs leading-5 text-muted-foreground">
          Site changes go live with your next publish.
        </p>
      </SidebarViewFooter>
    </>
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

import {
  DOCS_PAGE_SLUG_PATTERN,
  type DocsContentOverviewDto,
  type DocsContentPageDetailDto,
} from "@doxahq/contracts"

import { sectionHrefPrefix, sourcePathForHref } from "~/lib/dashboard/content-drag"
import type { ContentTreeSection } from "~/lib/dashboard/content-navigation"

/** The part of a page URL that a rename can change. */
export interface PageSlugTarget {
  /** The section path before the slug. Empty in the default section. */
  prefix: string
  slug: string
  /** A rename sends the title too, so the current one goes with it. */
  title: string
}

/**
 * Finds the editable slug of a page, or null when the page has none.
 *
 * A page outside every section cannot be renamed, because the server renames
 * only pages that a section holds. The start page of a section has no slug of
 * its own: its URL is the section path.
 */
export function pageSlugTarget(
  tree: readonly ContentTreeSection[],
  href: string | null,
): PageSlugTarget | null {
  if (!href) return null
  for (const section of tree) {
    if (section.slug === "__other") continue
    const page = section.groups.flatMap((group) => group.pages).find((candidate) => candidate.href === href)
    if (!page) continue
    const prefix = sectionHrefPrefix(section)
    const root = prefix ? `/${prefix}` : "/"
    if (href === root || !href.startsWith(prefix ? `${root}/` : "/")) return null
    return { prefix, slug: href.slice(root.length + (prefix ? 1 : 0)), title: page.title }
  }
  return null
}

export function pageHrefFromSlug(prefix: string, slug: string): string {
  return `/${[prefix, slug.trim()].filter(Boolean).join("/")}`
}

/** The message for a slug the server would refuse, or null for a valid one. */
export function pageSlugError(value: string): string | null {
  return DOCS_PAGE_SLUG_PATTERN.test(value.trim())
    ? null
    : "Use lowercase letters, numbers, and single hyphens between words."
}

/**
 * The overview as it reads after a page moved from one href to another.
 *
 * The editor follows a rename before the overview refetch returns. Until then,
 * this view keeps the open page in the list, so nothing jumps to another page.
 * An overview that already has the new href, or no longer has the old one, is
 * returned unchanged.
 */
export function followPageRename(
  overview: DocsContentOverviewDto,
  from: string,
  to: string,
): DocsContentOverviewDto {
  const pages = overview.pages
  if (from === to || pages.some((page) => page.href === to) || !pages.some((page) => page.href === from)) {
    return overview
  }
  const rename = (href: string) => (href === from ? to : href)
  return {
    ...overview,
    pages: pages.map((page) =>
      page.href === from ? { ...page, href: to, sourcePath: sourcePathForHref(to), status: "edited" as const } : page,
    ),
    navigation: overview.navigation.map((section) => ({
      ...section,
      groups: section.groups.map((group) => ({ ...group, hrefs: group.hrefs.map(rename) })),
    })),
    working: { ...overview.working, editedHrefs: [...new Set(overview.working.editedHrefs.map(rename).concat(to))] },
  }
}

/**
 * The detail of a renamed page, predicted from the detail before the rename.
 * The body moves unchanged. The new path has no published copy yet, so the
 * page reads as edited until the next publish.
 */
export function renamedPageDetail(previous: DocsContentPageDetailDto, to: string): DocsContentPageDetailDto {
  return {
    ...previous,
    href: to,
    sourcePath: sourcePathForHref(to),
    status: "edited",
    publishedContent: "",
    workingContent: previous.workingContent ?? previous.publishedContent,
  }
}

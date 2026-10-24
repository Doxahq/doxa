import type {
  DocsContentNavigationGroupDto,
  DocsContentNavigationSectionDto,
  DocsContentPageDto,
} from "@doxahq/contracts"
import { resolveHomeHref } from "@doxahq/site-config"

type HomePageConfig = Parameters<typeof resolveHomeHref>[0]

/** The default page as the page list shows it. */
export interface ContentHomePage {
  /** The page that the site root shows. */
  href: string | null
  /** True while a new choice waits for the server. `href` already shows it. */
  pending: boolean
}

export interface ContentTreeGroup {
  /** Stable key for expansion state and React rendering. */
  id: string
  heading: string | null
  groupIndex: number | null
  pages: DocsContentPageDto[]
  editedCount: number
}

export interface ContentTreeSection {
  slug: string
  label: string
  isDefault: boolean
  groups: ContentTreeGroup[]
  editedCount: number
}

/**
 * Joins the flat page list to the published arrangement.
 *
 * Pages without a navigation placement go into a trailing section. As a
 * result, every manifest page stays reachable in the content editor.
 */
export function buildContentTree(
  pages: readonly DocsContentPageDto[],
  navigation: readonly DocsContentNavigationSectionDto[],
): ContentTreeSection[] {
  const pagesByHref = new Map(pages.map((page) => [page.href, page] as const))
  const placedHrefs = new Set<string>()
  const sections: ContentTreeSection[] = []

  for (const section of navigation) {
    const groups: ContentTreeGroup[] = []
    const headingCounts = new Map<string, number>()

    for (const group of section.groups) {
      const groupPages: DocsContentPageDto[] = []
      for (const href of group.hrefs) {
        const page = pagesByHref.get(href)
        if (!page || placedHrefs.has(href)) continue
        groupPages.push(page)
        placedHrefs.add(href)
      }
      // A heading with no page yet stays visible, so its "New page" action can fill it.
      if (groupPages.length === 0 && !isEmptyHeadingGroup(group)) continue

      const occurrence = headingCounts.get(group.heading ?? "") ?? 0
      headingCounts.set(group.heading ?? "", occurrence + 1)
      groups.push(
        createTreeGroup(
          section.slug,
          occurrence,
          group.groupIndex,
          group.heading,
          groupPages,
        ),
      )
    }
    if (groups.length === 0) continue

    sections.push({
      slug: section.slug,
      label: section.label,
      isDefault: section.isDefault,
      groups,
      editedCount: sumEditedPages(groups),
    })
  }

  const orphanPages = pages.filter((page) => !placedHrefs.has(page.href))
  if (orphanPages.length > 0) {
    const group = createTreeGroup("__other", 0, null, null, orphanPages)
    sections.push({
      slug: "__other",
      label: "Other",
      isDefault: false,
      groups: [group],
      editedCount: group.editedCount,
    })
  }

  return sections
}

function isEmptyHeadingGroup(group: DocsContentNavigationGroupDto): boolean {
  return group.heading !== null && group.hrefs.length === 0
}

/** Section and group ids that must be open for this page to be visible. */
export function findPagePath(
  tree: readonly ContentTreeSection[],
  href: string | null,
): { sectionSlug: string; groupId: string } | null {
  if (!href) return null

  for (const section of tree) {
    for (const group of section.groups) {
      if (group.pages.some((page) => page.href === href)) {
        return { sectionSlug: section.slug, groupId: group.id }
      }
    }
  }
  return null
}

/**
 * Builds one group of the tree.
 *
 * The id carries the heading and how often that heading repeats in the section,
 * never the group index. A move renumbers every later index, and an id built
 * from an index would change with it. The tree would then read the group as a
 * new one and collapse it under the user.
 */
function createTreeGroup(
  sectionSlug: string,
  occurrence: number,
  groupIndex: number | null,
  heading: string | null,
  pages: DocsContentPageDto[],
): ContentTreeGroup {
  return {
    id: `${sectionSlug}:${heading ?? ""}#${occurrence}`,
    heading,
    groupIndex,
    pages,
    editedCount: pages.filter((page) => page.status === "edited").length,
  }
}

function sumEditedPages(groups: readonly ContentTreeGroup[]): number {
  return groups.reduce((total, group) => total + group.editedCount, 0)
}

/**
 * The first edited page in sidebar order, or null when no page changed.
 * Pages outside the navigation come after it, in overview order.
 */
export function firstChangedHref(
  pages: readonly DocsContentPageDto[],
  navigation: readonly DocsContentNavigationSectionDto[],
): string | null {
  const edited = new Set(pages.filter((page) => page.status === "edited").map((page) => page.href))
  if (edited.size === 0) return null
  const inSidebarOrder = navigation.flatMap((section) => section.groups.flatMap((group) => group.hrefs))
  return inSidebarOrder.find((href) => edited.has(href)) ?? pages.find((page) => edited.has(page.href))?.href ?? null
}

/**
 * The page that the site root shows, by the renderer's rule: the chosen home
 * page of the site config while it exists, else the first page of the default
 * section. The working config of the branch wins over the published one.
 */
export function contentHomeHref(
  pages: readonly DocsContentPageDto[],
  navigation: readonly DocsContentNavigationSectionDto[],
  siteConfig: { published: HomePageConfig; working: HomePageConfig | null } | null | undefined,
): string | null {
  const hrefs = new Set(pages.map((page) => page.href))
  const firstHref =
    navigation
      .find((section) => section.isDefault)
      ?.groups.flatMap((group) => group.hrefs)
      .find((href) => hrefs.has(href)) ?? null
  const config = siteConfig ? (siteConfig.working ?? siteConfig.published) : {}
  return resolveHomeHref(config, (href) => hrefs.has(href), firstHref)
}

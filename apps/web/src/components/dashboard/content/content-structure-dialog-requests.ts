import type {
  ContentTreeGroup,
  ContentTreeSection,
} from "~/lib/dashboard/content-navigation"
import type { ContentStructureActions } from "~/lib/dashboard/use-content-structure"
import type { ContentStructureDialogRequest } from "~/components/dashboard/content/content-structure-dialog"
import type { ContentDeleteConfirmationValue } from "~/components/dashboard/content/content-delete-confirmation"

type SelectPage = (href: string) => void

export function renameSectionRequest(
  section: ContentTreeSection,
  structure: ContentStructureActions | undefined,
): ContentStructureDialogRequest {
  return {
    title: "Rename section",
    description: "Change the section name. Its URL prefix stays the same.",
    nameLabel: "Section name",
    initialName: section.label,
    submitLabel: "Save name",
    onSubmit: async ({ name }) => structure?.renameSection(section.slug, name.trim()),
  }
}

export function createGroupRequest(
  section: ContentTreeSection,
  structure: ContentStructureActions | undefined,
  onSelect: SelectPage,
): ContentStructureDialogRequest {
  return {
    title: "New group",
    description: `Add a group and its first page to ${section.label}.`,
    nameLabel: "Group name",
    submitLabel: "Create group",
    onSubmit: async ({ name }) => {
      const href = await structure?.createGroup(section.slug, name.trim())
      if (href) onSelect(href)
    },
  }
}

export function renameGroupRequest(
  section: ContentTreeSection,
  group: ContentTreeGroup,
  structure: ContentStructureActions | undefined,
): ContentStructureDialogRequest {
  return {
    title: "Rename group",
    description: "Change the heading shown above this group.",
    nameLabel: "Group name",
    initialName: group.heading ?? "",
    submitLabel: "Save name",
    onSubmit: async ({ name }) => {
      if (group.groupIndex !== null) {
        await structure?.renameGroup(section.slug, group.groupIndex, name.trim())
      }
    },
  }
}

export function createPageRequest(
  section: ContentTreeSection,
  group: ContentTreeGroup | null,
  structure: ContentStructureActions | undefined,
  onSelect: SelectPage,
): ContentStructureDialogRequest {
  return {
    title: "New page",
    description: `Add a page to ${group?.heading ?? section.label}.`,
    nameLabel: "Page title",
    slugKind: "page",
    hrefPrefix: sectionHrefPrefix(section),
    submitLabel: "Create page",
    onSubmit: async ({ name, slug }) => {
      const href = await structure?.createPage(
        section.slug,
        group?.groupIndex ?? null,
        name.trim(),
        slug.trim(),
      )
      if (href) onSelect(href)
    },
  }
}

export function renamePageRequest(
  section: ContentTreeSection,
  page: ContentTreeGroup["pages"][number],
  structure: ContentStructureActions | undefined,
  onSelect: SelectPage,
): ContentStructureDialogRequest {
  return {
    title: "Rename page",
    description: "Change the page title and its URL inside this section.",
    nameLabel: "Page title",
    initialName: page.title,
    initialSlug: pageSlug(section, page.href),
    slugKind: "page",
    hrefPrefix: sectionHrefPrefix(section),
    submitLabel: "Save page",
    onSubmit: async ({ name, slug }) => {
      await structure?.renamePage(page.href, name.trim(), slug.trim())
      onSelect(pageHref(sectionHrefPrefix(section), slug))
    },
  }
}

export function sectionHrefPrefix(section: ContentTreeSection): string {
  const isDefault = section.groups.some((group) =>
    group.pages.some(
      (page) =>
        !page.href.startsWith(`/${section.slug}/`) && page.href !== `/${section.slug}`,
    ),
  )
  return isDefault ? "" : section.slug
}

function pageSlug(section: ContentTreeSection, href: string): string {
  const prefix = sectionHrefPrefix(section)
  const withoutPrefix = prefix
    ? href.replace(new RegExp(`^/${prefix}/?`), "")
    : href.slice(1)
  return withoutPrefix || section.slug
}

function pageHref(prefix: string, slug: string): string {
  return `/${[prefix, slug.trim()].filter(Boolean).join("/")}`
}

/**
 * Delete requests.
 *
 * The page count comes from the tree, which holds only the pages the manifest
 * lists. That is the same set the server deletes, so the count the reader sees
 * is the count that goes.
 */
export function deleteSectionRequest(
  section: ContentTreeSection,
  structure: ContentStructureActions | undefined,
): ContentDeleteConfirmationValue {
  return {
    target: `the section ${section.label}`,
    pageCount: countSectionPages(section),
    onConfirm: async () => structure?.deleteSection(section.slug),
  }
}

export function deleteGroupRequest(
  section: ContentTreeSection,
  group: ContentTreeGroup,
  structure: ContentStructureActions | undefined,
): ContentDeleteConfirmationValue {
  return {
    target: `the group ${group.heading ?? ""}`,
    pageCount: group.pages.length,
    onConfirm: async () => {
      if (group.groupIndex === null) return
      await structure?.deleteGroup(section.slug, group.groupIndex)
    },
  }
}

export function deletePageRequest(
  page: { href: string; title: string },
  structure: ContentStructureActions | undefined,
): ContentDeleteConfirmationValue {
  return {
    target: `the page ${page.title}`,
    pageCount: 0,
    onConfirm: async () => structure?.deletePage(page.href),
  }
}

function countSectionPages(section: ContentTreeSection): number {
  return section.groups.reduce((total, group) => total + group.pages.length, 0)
}

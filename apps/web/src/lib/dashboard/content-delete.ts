import type {
  DocsContentEdit,
  DocsContentNavigationSectionDto,
} from "@doxahq/contracts"

export type ContentDeleteEdit = Extract<
  DocsContentEdit,
  { type: "delete_page" | "delete_group" | "delete_section" }
>

interface RunContentDeleteOptions<Result> {
  deletesSelectedPage: boolean
  saveBuffer: () => Promise<boolean>
  /** Cancels autosave, clears the buffer, and returns its restore operation. */
  suspendBuffer: () => () => void
  waitForPendingSaves: () => Promise<void>
  deleteContent: () => Promise<Result>
}

export const CONTENT_STRUCTURE_SAVE_REQUIRED_MESSAGE =
  "Save the current page before changing the documentation structure."

/** Reports whether a delete operation contains the selected page. */
export function contentDeleteIncludesPage(
  edit: ContentDeleteEdit,
  selectedHref: string | null,
  navigation: readonly DocsContentNavigationSectionDto[],
): boolean {
  if (!selectedHref) return false
  if (edit.type === "delete_page") return edit.href === selectedHref

  const section = navigation.find((candidate) =>
    candidate.slug === (edit.type === "delete_section" ? edit.slug : edit.sectionSlug),
  )
  if (!section) return false
  if (edit.type === "delete_section") {
    return section.groups.some((group) => group.hrefs.includes(selectedHref))
  }

  return section.groups.some(
    (group) => group.groupIndex === edit.groupIndex && group.hrefs.includes(selectedHref),
  )
}

/** Applies the buffer policy before one destructive structure operation. */
export async function runContentDelete<Result>({
  deletesSelectedPage,
  saveBuffer,
  suspendBuffer,
  waitForPendingSaves,
  deleteContent,
}: RunContentDeleteOptions<Result>): Promise<Result> {
  if (!deletesSelectedPage) {
    if (!(await saveBuffer())) throw new Error(CONTENT_STRUCTURE_SAVE_REQUIRED_MESSAGE)
    return deleteContent()
  }

  const restoreBuffer = suspendBuffer()
  await waitForPendingSaves()
  try {
    return await deleteContent()
  } catch (error) {
    restoreBuffer()
    throw error
  }
}

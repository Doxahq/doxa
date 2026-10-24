import type { ReactNode } from "react"
import type { DocsPageMdxIssues } from "@doxahq/contracts"
import { FileText, FileWarning } from "lucide-react"

import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { formatIssueLine } from "~/lib/dashboard/mdx-issues"
import type { useProjectContent } from "~/lib/dashboard/use-project-content"

type ContentState = ReturnType<typeof useProjectContent>

/** Pieces shared by the panels of the publish menu. */
export function PanelHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="border-b border-divider px-5 pt-4 pb-3">
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
    </div>
  )
}

export function ChangedPages({ state, changeCount }: { state: ContentState; changeCount: number }) {
  const editedPages = state.pages.filter((page) => page.status === "edited")
  const otherChanges = Math.max(0, changeCount - editedPages.length)
  return (
    <>
      <div className="flex items-baseline justify-between px-5 pt-3.5 pb-1.5">
        <MenuSectionLabel>Changed pages</MenuSectionLabel>
        <span className="font-mono text-[10.5px] text-label">{editedPages.length}</span>
      </div>
      {/* The list scrolls inside an inset area, so its scrollbar and the cut
          rows keep a gap from the menu border and the footer line. */}
      <div className="scrollbar-subtle mx-2 mb-2 max-h-72 overflow-y-auto">
        {editedPages.length > 0 ? (
          <ul>
            {editedPages.map((page) => (
              <li key={page.href} className="flex items-center gap-2.5 px-3 py-2 text-sm text-foreground">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
                <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">{page.href}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-1.5 text-[13px] text-muted-foreground">No page content changed.</p>
        )}
        {otherChanges > 0 ? (
          <p className="px-3 pt-1 pb-1.5 text-xs text-muted-foreground">
            Also {plural(otherChanges, "structure or site settings change")}.
          </p>
        ) : null}
      </div>
    </>
  )
}

/**
 * v2 spec 8.1: the changed pages that fail the MDX check. A publish waits
 * until the list is empty; each row opens its page in the editor.
 */
export function MdxBlockedPages({
  pages,
  titleOf,
  onOpenPage,
}: {
  pages: readonly DocsPageMdxIssues[]
  titleOf: (href: string) => string
  onOpenPage: (href: string) => void
}) {
  if (pages.length === 0) return null
  return (
    <section aria-label="Pages with MDX issues" className="mx-4 mt-3 rounded-md border border-danger/40 bg-danger/10">
      <p role="alert" className="px-3 pt-2.5 text-[13px] text-danger">
        Fix the MDX in {plural(pages.length, "page")} before you publish.
      </p>
      <ul className="scrollbar-subtle max-h-40 overflow-y-auto py-1.5">
        {pages.map((page) => {
          const [first] = page.issues
          return (
            <li key={page.href}>
              <button
                type="button"
                onClick={() => onOpenPage(page.href)}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-overlay"
              >
                <FileWarning aria-hidden="true" className="size-4 shrink-0 text-danger" />
                <span className="min-w-0 flex-1 truncate">{titleOf(page.href)}</span>
                {first ? (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatIssueLine(first)}
                    {page.issues.length > 1 ? ` +${page.issues.length - 1}` : ""}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Closes the menu and opens a page in the editor, after the buffer saves. */
export function openPage(
  target: { state: ContentState; onOpenChange: (open: boolean) => void },
  href: string,
) {
  target.onOpenChange(false)
  void target.state.selectPage(href)
}

export function pageTitle(state: ContentState, href: string): string {
  return state.pages.find((page) => page.href === href)?.title || href
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}


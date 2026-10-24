import { useMemo, useState, type Ref } from "react"
import { Plus } from "lucide-react"
import type {
  DocsContentNavigationSectionDto,
  DocsContentPageDto,
} from "@doxahq/contracts"

import { ContentPageRow } from "~/components/dashboard/content/content-page-row"
import {
  PageListTop,
  PageSearchField,
  PagesHeading,
} from "~/components/dashboard/content/content-page-list-top"
import { ContentPageTree, type PageAgentControls } from "~/components/dashboard/content/content-page-tree"
import {
  PageSettingsDialog,
  type PageSettingsTarget,
} from "~/components/dashboard/content/page-settings-dialog"
import {
  ContentDeleteConfirmation,
  type ContentDeleteConfirmationValue,
} from "~/components/dashboard/content/content-delete-confirmation"
import {
  ContentStructureDialog,
  type ContentStructureDialogRequest,
} from "~/components/dashboard/content/content-structure-dialog"
import { Button } from "~/components/ui/button"
import { buildContentTree, type ContentHomePage } from "~/lib/dashboard/content-navigation"
import type { ContentStructureActions } from "~/lib/dashboard/use-content-structure"
import { usePageLocks } from "~/lib/dashboard/use-page-locks"

interface ContentPageListProps {
  projectId: string
  pages: readonly DocsContentPageDto[]
  navigation: readonly DocsContentNavigationSectionDto[]
  selectedHref: string | null
  /** The page that the site root shows. Its row carries a "Default" label. */
  home: ContentHomePage
  onSelect: (href: string) => void
  disabled?: boolean
  /** Hides New section and the row actions, for a role without `docs.write`. */
  readOnly?: boolean
  structure?: ContentStructureActions
  /** Lets the shell focus the search: "Go to", ⌘K and the "/" key. */
  searchInputRef?: Ref<HTMLInputElement>
}

/**
 * Documentation page list, rendered in the sidebar's Content view.
 *
 * The page list lives in the sidebar, which leaves the whole main area to the
 * editor and the preview.
 */
export function ContentPageList({
  projectId,
  pages,
  navigation,
  selectedHref,
  home,
  onSelect,
  disabled = false,
  readOnly = false,
  structure,
  searchInputRef,
}: ContentPageListProps) {
  const [query, setQuery] = useState("")
  const [dialog, setDialog] = useState<ContentStructureDialogRequest | null>(null)
  const [deletion, setDeletion] = useState<ContentDeleteConfirmationValue | null>(null)
  const [settingsPage, setSettingsPage] = useState<PageSettingsTarget | null>(null)
  const locks = usePageLocks(projectId)
  const pageAgents: PageAgentControls = {
    isLocked: locks.isLocked,
    ...(readOnly ? {} : { openSettings: setSettingsPage }),
  }

  const visiblePages = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return pages
    return pages.filter(
      (page) =>
        page.title.toLowerCase().includes(term) || page.href.toLowerCase().includes(term),
    )
  }, [pages, query])

  const editedCount = pages.filter((page) => page.status === "edited").length
  const tree = useMemo(() => buildContentTree(pages, navigation), [navigation, pages])
  const isSearching = query.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageListTop>
        <PagesHeading>
          <span className="flex items-center gap-1">
            {editedCount > 0 ? (
              <span className="rounded-sm border border-warning/35 bg-warning/8 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.12em] text-warning uppercase">
                {editedCount} edited
              </span>
            ) : null}
            {readOnly ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="New section"
                title="New section"
                disabled={disabled}
                onClick={() => setDialog(createSectionRequest(structure, onSelect, setDialog))}
              >
                <Plus aria-hidden="true" className="size-4" />
              </Button>
            )}
          </span>
        </PagesHeading>
        <PageSearchField
          ref={searchInputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault()
              setQuery("")
            }
          }}
        />
      </PageListTop>

      <nav
        aria-label="Documentation pages"
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto"
      >
        {isSearching && visiblePages.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No page matches this search.
          </p>
        ) : isSearching ? (
          visiblePages.map((page) => (
            <ContentPageRow
              key={page.href}
              page={page}
              isSelected={page.href === selectedHref}
              home={home}
              onSelect={onSelect}
              disabled={disabled}
              isLocked={locks.isLocked(page.href)}
            />
          ))
        ) : (
          <ContentPageTree
            projectId={projectId}
            tree={tree}
            selectedHref={selectedHref}
            home={home}
            onSelect={onSelect}
            disabled={disabled}
            readOnly={readOnly}
            structure={structure}
            openDialog={setDialog}
            onDelete={setDeletion}
            pageAgents={pageAgents}
          />
        )}
      </nav>
      <PageSettingsDialog
        projectId={projectId}
        page={settingsPage}
        onClose={() => setSettingsPage(null)}
      />
      <ContentStructureDialog
        request={dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      />
      <ContentDeleteConfirmation
        value={deletion}
        pending={structure?.isPending ?? false}
        onOpenChange={(open) => {
          if (!open) setDeletion(null)
        }}
      />
    </div>
  )
}

function createSectionRequest(
  structure: ContentStructureActions | undefined,
  onSelect: (href: string) => void,
  close: (request: ContentStructureDialogRequest | null) => void,
): ContentStructureDialogRequest {
  return {
    title: "New section",
    description: "Create a documentation section with its first page.",
    nameLabel: "Section name",
    slugKind: "section",
    submitLabel: "Create section",
    onSubmit: async ({ name, slug }) => {
      const href = await structure?.createSection(slug.trim(), name.trim())
      close(null)
      if (href) onSelect(href)
    },
  }
}

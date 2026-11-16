import { memo } from "react"
import type { DocsContentPageDto } from "@doxahq/contracts"
import { Loader2 } from "lucide-react"

import {
  contentRowIndent,
  type ContentRowDepth,
} from "~/components/dashboard/content/content-row-indent"
import { AgentLockMark } from "~/components/dashboard/content/agent-lock-mark"
import { DocsPageIcon } from "~/components/dashboard/content/docs-icon"
import { ReviewChangeDot } from "~/components/dashboard/content/review/review-marks"
import type { ContentHomePage } from "~/lib/dashboard/content-navigation"
import { PAGE_LABEL_CLASS } from "~/components/dashboard/content/content-row-classes"
import { cn } from "~/lib/utils"
import { ContentRowActions } from "~/components/dashboard/content/content-row-actions"
import { useReviewPageMark } from "~/lib/dashboard/review-page-marks-context"
import { useIsAgentLivePage } from "~/lib/dashboard/agent-live-page-context"
import { AgentStatusDot } from "~/components/dashboard/content/agent-activity/agent-status-dot"

interface ContentPageRowProps {
  page: DocsContentPageDto
  /** True for the open page. A boolean, so a page switch re-renders only two rows. */
  isSelected: boolean
  /** The page that the site root shows. Its row carries a "Default" label. */
  home: ContentHomePage
  onSelect: (href: string) => void
  disabled: boolean
  depth?: ContentRowDepth
  onRename?: () => void
  onDelete?: () => void
  /** Makes this page the one that the site root shows. */
  onSetHome?: () => void
  /** True when a person locked the page against generations. */
  isLocked?: boolean
  /** Opens the settings of this page. */
  onOpenPageSettings?: () => void
}

/** One selectable documentation page in the content sidebar. */
export const ContentPageRow = memo(function ContentPageRow({
  page,
  isSelected,
  home,
  onSelect,
  disabled,
  depth = 0,
  onRename,
  onDelete,
  onSetHome,
  isLocked = false,
  onOpenPageSettings,
}: ContentPageRowProps) {
  const isHome = page.href === home.href
  // In a review, the dot says what the generation does to the page. It
  // replaces the edited dot, because every generated page is an edit. It
  // stays on hover, so its tooltip can open.
  const reviewMark = useReviewPageMark(page.href)
  const isAgentHere = useIsAgentLivePage(page.href)

  return (
    <div
      style={contentRowIndent(depth)}
      // The active bar is an inset shadow, not a border, so the selected row
      // keeps the same indent as the section and group rows around it.
      className={cn(
        "group/row flex",
        isSelected
          ? "bg-primary-wash shadow-[inset_2px_0_0_var(--primary)]"
          : "hover:bg-overlay",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(page.href)}
        disabled={disabled}
        aria-current={isSelected ? "page" : undefined}
        title={page.href}
        className={cn(
          PAGE_LABEL_CLASS,
          "disabled:cursor-not-allowed disabled:opacity-60",
          isSelected ? "text-primary-text" : "text-muted-foreground hover:text-foreground",
        )}
      >
      <DocsPageIcon name={page.icon} className="size-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{page.title}</span>
      {isHome && home.pending ? (
        <Loader2
          role="status"
          aria-label="Setting the default page"
          className="size-3.5 shrink-0 text-muted-foreground animate-spin"
        />
      ) : isHome ? (
        // The row actions show on hover, so the label steps aside.
        <span
          title="The site root shows this page"
          className="shrink-0 font-mono text-[9.5px] font-medium tracking-[0.14em] text-label uppercase group-hover/row:invisible"
        >
          Default
        </span>
      ) : null}
      {/* It stays on hover, so its tooltip can open. The row actions have their own space. */}
      {isLocked ? <AgentLockMark /> : null}
      {isAgentHere ? (
        <span role="img" aria-label="An agent is working on this page" className="flex shrink-0">
          <AgentStatusDot presence="active" />
        </span>
      ) : null}
      {reviewMark ? (
        <ReviewChangeDot change={reviewMark.change} />
      ) : page.status === "edited" ? (
        <span
          aria-label="Unpublished changes"
          title="Unpublished changes"
        className="mr-1 size-1.5 shrink-0 rounded-full bg-warning group-hover/row:invisible"
        />
      ) : null}
      </button>
      {onRename && onDelete ? (
        <ContentRowActions
          target={`the page ${page.title}`}
          onRename={onRename}
          onDelete={onDelete}
          deleteDisabledReason={null}
          defaultAction={onSetHome ? { isDefault: isHome, onSelect: onSetHome } : undefined}
          onOpenPageSettings={onOpenPageSettings}
          disabled={disabled}
        />
      ) : null}
    </div>
  )
})

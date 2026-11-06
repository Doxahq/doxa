import type { OwnedPageFlag } from "@doxahq/contracts/generation-reviews"
import { LockOpen } from "lucide-react"

import { SECTION_LABEL_CLASS } from "~/components/dashboard/content/content-row-classes"
import { Button } from "~/components/ui/button"
import { ownedPageFlagSummary } from "~/lib/dashboard/owned-page-flag-text"
import { usePageLocks } from "~/lib/dashboard/use-page-locks"
import { cn } from "~/lib/utils"

/**
 * Pages that a person locked that the run did not update although their code
 * or the instructions changed, or that the new plan left out. The person
 * checks each one, or unlocks it so the next run can update it.
 */
export function ReviewOwnedPages(props: {
  projectId: string
  flags: readonly OwnedPageFlag[]
  focusHref: string | null
  canWrite: boolean
  onSelect: (href: string) => void
}) {
  const locks = usePageLocks(props.projectId)
  if (props.flags.length === 0) return null

  return (
    <section aria-label="Locked pages that need a check" className="border-t border-divider pt-1 pb-2">
      <h3 className={cn(SECTION_LABEL_CLASS, "px-4 text-label")}>
        Locked pages to check
        <span className="text-faint">{props.flags.length}</span>
      </h3>
      <ul>
        {props.flags.map((flag) => {
          const isLocked = locks.isLocked(flag.href)
          const isSelected = flag.href === props.focusHref
          return (
            <li
              key={flag.href}
              className={cn(
                "flex items-center gap-1 pr-2",
                isSelected ? "bg-primary-wash shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-overlay",
              )}
            >
              <button
                type="button"
                onClick={() => props.onSelect(flag.href)}
                aria-current={isSelected ? "page" : undefined}
                title={flag.changedPaths.length > 0 ? `Changed: ${flag.changedPaths.join(", ")}` : ownedPageFlagSummary(flag)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col py-1.5 pl-4 text-left",
                  isSelected ? "text-primary-text" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="truncate text-[13.5px]">{flag.title}</span>
                <span className="truncate font-mono text-[10.5px] text-faint">
                  {ownedPageFlagSummary(flag)}
                </span>
              </button>
              {props.canWrite && isLocked ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={locks.updatingHref === flag.href}
                  title="Unlock this page, so the next generation can update it"
                  onClick={() => locks.setLocked(flag.href, false)}
                >
                  <LockOpen aria-hidden="true" />
                  Unlock
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

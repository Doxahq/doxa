import { Search } from "lucide-react"

import { useCommandMenu } from "~/components/dashboard/command-menu/command-menu"

/** "Search or jump to…" under the logo. Like ⌘K, it opens the command menu on every page. */
export function SidebarSearchButton() {
  const { setOpen } = useCommandMenu()

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-surface-hover"
    >
      <Search aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
      <kbd className="rounded-sm border border-border px-1 py-px font-mono text-[10.5px] text-faint">⌘K</kbd>
    </button>
  )
}

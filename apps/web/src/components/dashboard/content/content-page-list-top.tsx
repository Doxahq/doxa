import type { ComponentProps, ReactNode } from "react"
import { Search } from "lucide-react"

import { Input } from "~/components/ui/input"

/**
 * The top of the page list: the heading and the search. The loading skeleton
 * draws the same parts, so nothing moves when the list arrives.
 */
export function PageListTop({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-2 pb-2">{children}</div>
}

/** "PAGES", with the list actions on the right. */
export function PagesHeading({ children }: { children?: ReactNode }) {
  return (
    // The minimum height is the action button's, so a role without the button,
    // and the loading skeleton, keep the same height. It is inline, like the
    // skeleton bars, because a dev server can miss a new utility class.
    <div
      style={{ minHeight: "1.75rem", boxSizing: "content-box" }}
      className="flex items-center justify-between gap-2 px-2.5 pt-2 pb-1.5"
    >
      <span className="font-mono text-[11px] font-medium tracking-[0.16em] text-label uppercase">
        Pages
      </span>
      {children}
    </div>
  )
}

/** The page search box, with its "/" shortcut hint. */
export function PageSearchField({
  ref,
  ...props
}: Omit<ComponentProps<typeof Input>, "placeholder" | "className">) {
  return (
    <div className="relative mx-0.5 mt-0.5">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={ref}
        placeholder="Find a page"
        aria-label="Find a page"
        aria-keyshortcuts="/"
        className="h-8 pr-8 pl-8 text-[13px]"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...props}
      />
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border border-border px-1.5 font-mono text-[10px] font-medium text-muted-foreground"
      >
        /
      </kbd>
    </div>
  )
}

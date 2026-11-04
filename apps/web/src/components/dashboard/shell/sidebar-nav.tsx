import { forwardRef, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from "react"
import { createLink } from "@tanstack/react-router"

import { cn } from "~/lib/utils"

/** Uppercase mono label above a group of sidebar items. */
export function SidebarSectionLabel({
  children,
  actions,
}: {
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-2.5 pt-4 pb-1.5">
      <span className="font-mono text-[11px] font-medium tracking-[0.16em] text-label uppercase">
        {children}
      </span>
      {actions ? <span className="flex items-center gap-0.5">{actions}</span> : null}
    </div>
  )
}

export const SIDEBAR_NAV_ITEM_CLASS =
  "flex w-full items-center gap-2.5 px-2.5 py-[7px] text-left text-[13.5px] whitespace-nowrap transition-colors [&>svg]:size-4 [&>svg]:shrink-0"

/** Active: a quiet grey fill, a step above the hover fill. No accent color. */
export function sidebarNavItemState(active: boolean): string {
  return active
    ? "bg-secondary text-foreground"
    : "text-body hover:bg-overlay hover:text-foreground"
}

interface SidebarNavAnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  icon: ComponentType<{ className?: string }>
  label: string
  hint?: ReactNode
  active: boolean
}

const SidebarNavAnchor = forwardRef<HTMLAnchorElement, SidebarNavAnchorProps>(
  ({ icon: Icon, label, hint, active, className, ...props }, ref) => (
    <a
      ref={ref}
      {...props}
      aria-current={active ? "page" : undefined}
      className={cn(SIDEBAR_NAV_ITEM_CLASS, sidebarNavItemState(active), className)}
    >
      <Icon aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      {hint ? <span className="ml-auto flex items-center gap-1.5">{hint}</span> : null}
    </a>
  ),
)
SidebarNavAnchor.displayName = "SidebarNavAnchor"

/** A sidebar row that is a route link, with typed `to` and `params`. */
export const SidebarNavLink = createLink(SidebarNavAnchor)

/** The small mono value on the right of a sidebar row. */
export function SidebarNavHint({
  children,
  tone = "muted",
}: {
  children: ReactNode
  tone?: "muted" | "warning" | "danger"
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-[11px]",
        tone === "muted" && "text-muted-foreground",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-danger",
      )}
    >
      {children}
    </span>
  )
}

/** Amber count pill, for example "1 edited". */
export function EditedPill({ count }: { count: number }) {
  return (
    <span className="rounded-sm border border-warning/35 bg-warning/8 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.12em] text-warning uppercase">
      {count} edited
    </span>
  )
}

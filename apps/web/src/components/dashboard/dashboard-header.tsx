import type { ReactNode } from "react"

import { TopBar } from "~/components/dashboard/shell/top-bar"
import { cn } from "~/lib/utils"

interface DashboardHeaderProps {
  title: string
  /** Optional right-aligned controls in the title row. */
  actions?: ReactNode
  /** Optional "more" menu. */
  menu?: ReactNode
}

/** The top bar for pages outside a project section: the title is the breadcrumb. */
export function DashboardHeader({ title, actions, menu }: DashboardHeaderProps) {
  return <TopBar crumbs={[title]} actions={actions} menu={menu} />
}

/**
 * The heading at the top of a settings or detail page: a mono section label,
 * a 26px title and a muted description.
 */
export function PageHeading({
  label,
  title,
  description,
  actions,
}: {
  label: string
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="font-mono text-[11px] font-medium tracking-[0.16em] text-label uppercase">
          {label}
        </span>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.015em] text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** Centered, constrained content column (the e2b General/Members/Billing look). */
export function PageBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className="flex flex-1 flex-col px-4 py-10 sm:px-6">
      <div className={cn("mx-auto flex w-full max-w-3xl flex-col gap-8", className)}>
        {children}
      </div>
    </div>
  )
}

/** Uppercase dashboard section title. */
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <h2
      className={cn(
        "font-mono text-sm font-bold tracking-[0.12em] text-foreground uppercase",
        className,
      )}
    >
      {children}
    </h2>
  )
}

/** Supporting copy for dashboard section headers. */
export function SectionDescription({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p className={cn("text-sm leading-6 text-muted-foreground", className)}>
      {children}
    </p>
  )
}

/** Uppercase mono key for a field: STATUS, SLUG, WORKSPACE. */
export const FIELD_LABEL_CLASS = "font-mono text-[11px] tracking-[0.16em] text-label uppercase"

/** Card that holds a list of `FieldRow`s. */
export function FieldList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn("surface-card", className)}>{children}</div>
}

/**
 * Key/value row in a detail card. It has no hover state, because the row
 * itself does nothing on click. The label column is fixed, so values line up
 * next to their labels instead of at the far edge. On mobile the label stacks
 * above the value. Pass `mono` for technical values: slugs, repositories, paths.
 */
export function FieldRow({
  label,
  children,
  mono = false,
  className,
}: {
  label: string
  children: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "grid gap-1.5 border-t border-divider px-5 py-4 first:border-t-0 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center sm:gap-4",
        className,
      )}
    >
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <div
        className={cn(
          "min-w-0 truncate text-foreground",
          mono ? "font-mono text-[13.5px]" : "text-[14.5px]",
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function MetaField({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <dt className={FIELD_LABEL_CLASS}>{label}</dt>
      <dd className="min-w-0 text-[14.5px] text-foreground">{children}</dd>
    </div>
  )
}

/** Toolbar row: leading content (search) on the left, actions on the right. */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>{children}</div>
  )
}

/** e2b-style centered empty card: uppercase mono title, description, CTA. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "surface-card mx-auto flex w-full max-w-md flex-col items-center gap-4 px-8 py-12 text-center",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground [&_svg]:size-6">{icon}</div> : null}
      <div className="flex flex-col gap-1.5">
        <p className="font-mono text-sm font-bold tracking-[0.12em] text-foreground uppercase">
          {title}
        </p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}

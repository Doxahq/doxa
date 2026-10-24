import type { ReactNode } from "react"

import { Badge } from "~/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import { Separator } from "~/components/ui/separator"
import { cn } from "~/lib/utils"

interface DashboardShellProps {
  eyebrow: string
  title: string
  description: string
  badge: string
  actions?: ReactNode
  sidebar: ReactNode
  children: ReactNode
}

interface DashboardPanelProps {
  title: string
  icon: ReactNode
  description?: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function DashboardShell({
  eyebrow,
  title,
  description,
  badge,
  actions,
  sidebar,
  children,
}: DashboardShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs tracking-[0.24em] text-primary uppercase">
                {eyebrow}
              </p>
              <Badge variant="outline">{badge}</Badge>
            </div>
            <div className="flex flex-col gap-3">
              <h1 className="font-mono text-5xl leading-none font-bold tracking-normal text-foreground uppercase sm:text-7xl">
                {title}
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </div>
          </div>
          {actions ? (
            <div className="flex flex-wrap gap-2 lg:justify-end">{actions}</div>
          ) : null}
        </div>
      </section>

      <section className="mx-auto grid max-w-[1200px] gap-4 px-4 py-6 sm:px-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:px-8">
        <aside className="flex flex-col gap-4">{sidebar}</aside>
        <main className="flex min-w-0 flex-col gap-4">{children}</main>
      </section>
    </div>
  )
}

export function DashboardPanel({
  title,
  icon,
  description,
  action,
  className,
  children,
}: DashboardPanelProps) {
  return (
    <Card className={cn("bg-card/70", className)}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 text-muted-foreground">{icon}</div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>{title}</CardTitle>
            {description ? (
              <CardDescription>{description}</CardDescription>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <Separator />
      <CardContent className="pt-5">{children}</CardContent>
    </Card>
  )
}

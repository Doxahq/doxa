import type { ReactNode } from "react"

import { cn } from "~/lib/utils"

/**
 * The auth page frame: a centered bordered card on the grid background. The
 * login page and the agent consent page share it. With `aside`, the card frame
 * takes the left of the page and `aside` the right (the login page's logo panel).
 * `plain` drops the card border, fill and padding, so the content sits on the
 * page itself (the sign-in and sign-up pages).
 */
export function AuthCard({
  children,
  className,
  aside,
  plain = false,
}: {
  children: ReactNode
  className?: string
  aside?: ReactNode
  plain?: boolean
}) {
  const frame = (
    <div className="grid-pattern relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10 font-sans">
      <div
        className={cn(
          "flex w-full max-w-sm flex-col items-center gap-8",
          !plain && "rounded-lg border border-border bg-card/70 px-8 py-12",
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
  if (!aside) return frame

  return (
    <div className="flex min-h-screen bg-background">
      <div className="min-w-0 flex-1">{frame}</div>
      {aside}
    </div>
  )
}

/** The mono uppercase title and muted description at the top of an auth card. */
export function AuthCardHeading({
  title,
  description,
}: {
  title: string
  description?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 text-center">
      {/* The left padding balances the letter spacing after the last letter, so the title centers optically. */}
      <h1 className="pl-[0.18em] font-mono text-xl font-bold tracking-[0.18em] text-foreground uppercase">
        {title}
      </h1>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  )
}

import type { ReactNode } from "react"

import { PixelDishArt } from "~/components/auth/auth-dish-art"
import { PixelDocsArt } from "~/components/auth/auth-pixel-art"
import { LogoMark } from "~/components/navigation/logo"
import { SAMPLE_DIFF } from "~/lib/marketing/home"
import { cn } from "~/lib/utils"

const MARK_SIZE = 26

/**
 * The art the panel shows on wide screens. Change this value to switch:
 * - "dish": the MCP page's antenna dish in pixels under twinkling stars (`auth-dish-art.tsx`).
 * - "pixels": a dithered docs page that breaks into pixels (`auth-pixel-art.tsx`).
 * - "sync": a code diff above the logo and the docs page it changes below.
 */
type PanelArt = "dish" | "pixels" | "sync"
const PANEL_ART = "sync" as PanelArt

/**
 * The right-hand panel of the login page, after planetscale.com: the Doxa logo
 * sits on the panel's left line, and the line stops above and below it. On wide
 * screens the panel also shows art (`PANEL_ART`). Hidden on small screens, where
 * the card's own mark is enough.
 */
export function AuthBrandPanel() {
  const sync = PANEL_ART === "sync"
  return (
    <aside className="relative hidden w-1/3 shrink-0 flex-col md:flex" aria-hidden="true">
      {/* Starts 1px in, so the line stays visible. */}
      {PANEL_ART === "dish" ? (
        <PixelDishArt className="absolute inset-y-0 right-0 left-px hidden overflow-hidden xl:block" />
      ) : null}
      {PANEL_ART === "pixels" ? (
        <PixelDocsArt className="absolute inset-y-0 right-0 left-px hidden overflow-hidden xl:block" />
      ) : null}
      <span className="flex-1 border-l border-border" />

      {sync ? <SyncTop /> : null}

      {/* Pulled left by half the mark, so the mark's center sits on the line. `relative`
          paints it above the card frame and the art, which are positioned too. */}
      <div className="relative flex items-center gap-3 py-4" style={{ marginLeft: -(MARK_SIZE / 2 - 0.5) }}>
        <span className={cn("flex", sync && "doxa-sync-mark")}>
          <LogoMark size={MARK_SIZE} />
        </span>
        <span className="font-mono text-2xl font-bold tracking-[0.22em] text-foreground uppercase">doxa</span>
      </div>

      {sync ? <SyncBottom /> : null}

      <span className="flex-1 border-l border-border" />
    </aside>
  )
}

/**
 * The "sync" art, above the logo: the code diff from the landing page, then the line
 * it leaves down to the logo. A dot runs down the line from the diff to the docs page
 * below the logo (the `doxa-sync-*` rules in globals.css).
 */
function SyncTop() {
  return (
    <>
      <SyncRow>
        <PaneBar label="SRC/API/USERS.TS">PR #142</PaneBar>
        <div className="h-24 py-2 font-mono text-[11px] leading-5 whitespace-pre">
          {SAMPLE_DIFF.map((row) => (
            <div key={row.line} className={`px-3 doxa-sync-${row.kind}`}>
              {row.line}
            </div>
          ))}
        </div>
      </SyncRow>
      <SyncRun dot="doxa-sync-dot--in" />
    </>
  )
}

/** The "sync" art, below the logo: the line on from the logo, then the docs page the diff changes. */
function SyncBottom() {
  return (
    <>
      <SyncRun dot="doxa-sync-dot--out" />
      <SyncRow>
        <PaneBar label="/DOCS/API/USERS">
          {/* Both states share one grid cell, and the loop shows one at a time. */}
          <span className="grid justify-items-end">
            <span className="doxa-sync-pending flex items-center gap-1.5 [grid-area:1/1]">
              <span className="size-1.5 animate-pulse bg-current" />
              SYNCING
            </span>
            <span className="doxa-sync-done flex items-center gap-1.5 [grid-area:1/1]">
              <span className="size-1.5 bg-current" />
              SYNCED
            </span>
          </span>
        </PaneBar>
        <div className="grid h-24">
          <DocsBody signature="getUsers()" summary="Returns every user in the database." />
          <DocsBody
            className="doxa-sync-new bg-editor"
            signature={
              <>
                getUsers(<span className="doxa-sync-changed">limit?</span>)
              </>
            }
            summary="Returns paginated users from the database."
          />
        </div>
      </SyncRow>
    </>
  )
}

/** A pane 40px right of the line. Its top and bottom edges run as dashed lines from the line to the page edge. */
function SyncRow({ children }: { children: ReactNode }) {
  return (
    <div className="doxa-sync-row relative hidden border-l border-border xl:block">
      <div className="relative z-[1] ml-10 w-[380px] max-w-[calc(100%-40px)] overflow-hidden border border-border bg-editor">
        {children}
      </div>
    </div>
  )
}

/** The stretch of line between a pane and the logo, with the dot that runs down it. */
function SyncRun({ dot }: { dot: string }) {
  return (
    <div className="relative hidden h-[72px] border-l border-border xl:block">
      <span className={`doxa-sync-dot ${dot}`} />
    </div>
  )
}

function PaneBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-[34px] items-center justify-between border-b border-border px-3 font-mono text-[10px] tracking-[0.08em] text-label">
      <span>{label}</span>
      {children}
    </div>
  )
}

/** The docs page under the bar. The updated copy sits on top of the old one in the same grid cell. */
function DocsBody({
  signature,
  summary,
  className,
}: {
  signature: ReactNode
  summary: string
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 px-3.5 py-3 [grid-area:1/1]", className)}>
      <span className="font-mono text-[13px] text-foreground">{signature}</span>
      <p className="font-sans text-xs leading-[18px] text-muted-foreground">{summary}</p>
    </div>
  )
}

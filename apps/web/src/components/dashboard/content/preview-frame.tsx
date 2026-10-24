import type { ReactNode } from "react"
import { ExternalLink } from "lucide-react"

import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { TOP_BAR_ICON_BUTTON_CLASS } from "~/components/dashboard/shell/top-bar"
import type { CanvasMode } from "~/lib/dashboard/site-canvas"
import { cn } from "~/lib/utils"

/** The site's Light/Dark switch of a preview. */
export interface PreviewColorMode {
  mode: CanvasMode
  onChange: (mode: CanvasMode) => void
}

/** Where the open button of a preview frame leads. */
export interface PreviewOpenLink {
  /** Null when there is no page to open yet. */
  url: string | null
  label: string
  /** The tooltip while there is no URL. */
  unavailableTitle: string
}

/**
 * A browser-style frame around a page preview: dots, the page's address,
 * optional controls, and a button that opens the page in a new tab.
 */
export function PreviewFrame(props: {
  host: string
  href: string
  open: PreviewOpenLink
  /** The site's Light/Dark switch, or null for a dark-only site. */
  colorMode: PreviewColorMode | null
  /** Controls before the color mode, for example the version of the page. */
  controls?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="m-4.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border bg-card px-3 py-2">
        <span aria-hidden="true" className="flex gap-1.5">
          <i className="size-[9px] rounded-full bg-border-strong" />
          <i className="size-[9px] rounded-full bg-border-strong" />
          <i className="size-[9px] rounded-full bg-border-strong" />
        </span>
        <span className="min-w-32 flex-1 truncate rounded-md border border-divider bg-background px-2.5 py-1 font-mono text-xs text-muted-foreground">
          {props.host}
          <span className="text-body">{props.href}</span>
        </span>
        {props.controls}
        {props.colorMode ? (
          <SegmentedControl
            label="Site color mode"
            value={props.colorMode.mode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValueChange={props.colorMode.onChange}
          />
        ) : null}
        <a
          href={props.open.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${props.open.label} in a new tab`}
          aria-disabled={!props.open.url}
          title={props.open.url ? props.open.label : props.open.unavailableTitle}
          className={cn(TOP_BAR_ICON_BUTTON_CLASS, !props.open.url && "pointer-events-none opacity-50")}
        >
          <ExternalLink aria-hidden="true" />
        </a>
      </div>
      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </div>
  )
}

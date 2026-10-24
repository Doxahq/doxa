import type { ReactNode } from "react";

import { cn } from "@/src/lib/utils";
import Copy from "@/src/components/markdown/copy";

/**
 * A code sample card for the reference rail: a compact header strip, an
 * optional detail label, a copy button, and a scrollable body.
 *
 * The body neutralizes the article's prose treatment for `pre`, so a sample
 * fills the card instead of drawing a second border inside it.
 */
export function CodeCard({
  heading,
  detail,
  copyText,
  children,
  className,
  bodyClassName,
}: {
  heading: ReactNode;
  detail?: ReactNode;
  copyText?: string;
  children: ReactNode;
  className?: string;
  /** Overrides the body scroll box. The playground is a form, not a sample. */
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "not-prose overflow-hidden rounded-xl border bg-card/60",
        className
      )}
    >
      <header className="flex items-center gap-2 border-b bg-muted/40 py-1.5 pr-1.5 pl-3">
        <div className="min-w-0 flex-1">{heading}</div>
        {typeof detail === "string" && detail ? (
          <span className="font-code shrink-0 text-[0.7rem] text-muted-foreground">
            {detail}
          </span>
        ) : (
          detail
        )}
        {copyText && <Copy content={copyText} />}
      </header>
      <div
        className={cn(
          "[&_code]:font-code max-h-[26rem] overflow-auto text-[0.8125rem] [&>pre]:m-0 [&>pre]:rounded-none [&>pre]:border-0 [&>pre]:bg-transparent [&>pre]:p-3",
          bodyClassName
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function CodeCardTitle({ children }: { children: ReactNode }) {
  return (
    <span className="block truncate text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

/**
 * Status selector for endpoints that document more than one response. A single
 * response renders as a plain label, so nothing looks clickable without reason.
 */
export function StatusTabs({
  statuses,
  active,
  onSelect,
}: {
  statuses: readonly string[];
  active: string;
  onSelect: (status: string) => void;
}) {
  if (statuses.length <= 1) {
    return (
      <span className="font-code text-xs text-muted-foreground">
        {statuses[0] ?? ""}
      </span>
    );
  }

  return (
    <div
      role="tablist"
      aria-label="Response status"
      className="flex scrollbar-none items-center gap-1 overflow-x-auto"
    >
      {statuses.map((status) => {
        const selected = status === active;
        return (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(status)}
            className={cn(
              "font-code cursor-pointer rounded px-1.5 py-1 text-xs transition-colors",
              selected
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {status}
          </button>
        );
      })}
    </div>
  );
}

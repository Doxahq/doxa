import type { Ref } from "react";
import { LuPlay } from "react-icons/lu";

import { endpointPathSegments } from "@/src/lib/endpoint-document";
import { cn } from "@/src/lib/utils";
import { ApiMethodBadge } from "@/src/components/markdown/api-method-badge";

/**
 * The method and path line. Path parameters get a chip so a reader can tell
 * them apart from fixed segments at a glance.
 */
export function EndpointPath({
  method,
  path,
  baseUrl,
  className,
}: {
  method: string;
  path: string;
  /** The owner's API address. It comes before the path when the site has one. */
  baseUrl?: string | null;
  className?: string;
}) {
  const segments = endpointPathSegments(path);

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <ApiMethodBadge method={method} />
      <code className="font-code flex min-w-0 scrollbar-none items-center overflow-x-auto text-[0.8125rem] whitespace-nowrap">
        {baseUrl && <span className="text-muted-foreground">{baseUrl}</span>}
        {segments.length === 0 && (
          <span className="text-muted-foreground">/</span>
        )}
        {segments.map((segment, index) => (
          <span
            key={`${segment.value}-${index}`}
            className="flex items-center gap-0.5"
          >
            <span className="text-muted-foreground/70">/</span>
            {segment.parameter ? (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                {segment.value}
              </span>
            ) : (
              <span className="px-0.5 text-foreground">{segment.value}</span>
            )}
          </span>
        ))}
      </code>
    </div>
  );
}

export function EndpointBar({
  method,
  path,
  baseUrl,
  onOpenTryIt,
  onTryItIntent,
  tryItRef,
}: {
  method: string;
  path: string;
  baseUrl?: string | null;
  onOpenTryIt?: () => void;
  /** The reader is about to press the control, so its code can load now. */
  onTryItIntent?: () => void;
  /** The modal gives focus back to this control when it closes. */
  tryItRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="not-prose flex items-center gap-3 rounded-lg border bg-card/50 py-1.5 pr-1.5 pl-3">
      <EndpointPath method={method} path={path} baseUrl={baseUrl} className="flex-1" />
      {onOpenTryIt && (
        <button
          ref={tryItRef}
          type="button"
          onClick={onOpenTryIt}
          onPointerEnter={onTryItIntent}
          onFocus={onTryItIntent}
          aria-haspopup="dialog"
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Try it
          <LuPlay className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

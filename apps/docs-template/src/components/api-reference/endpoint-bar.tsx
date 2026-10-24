import { LuPlay, LuX } from "react-icons/lu";

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
  className,
}: {
  method: string;
  path: string;
  className?: string;
}) {
  const segments = endpointPathSegments(path);

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <ApiMethodBadge method={method} />
      <code className="font-code flex min-w-0 scrollbar-none items-center overflow-x-auto text-[0.8125rem] whitespace-nowrap">
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
  tryItOpen,
  onToggleTryIt,
}: {
  method: string;
  path: string;
  tryItOpen?: boolean;
  onToggleTryIt?: () => void;
}) {
  return (
    <div className="not-prose flex items-center gap-3 rounded-lg border bg-card/50 py-1.5 pr-1.5 pl-3">
      <EndpointPath method={method} path={path} className="flex-1" />
      {onToggleTryIt && (
        <button
          type="button"
          onClick={onToggleTryIt}
          aria-expanded={tryItOpen ?? false}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {tryItOpen ? "Close" : "Try it"}
          {tryItOpen ? (
            <LuX className="size-3" aria-hidden="true" />
          ) : (
            <LuPlay className="size-3" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

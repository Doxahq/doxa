import { normalizeApiMethod } from "@/src/lib/api-reference";
import { cn } from "@/src/lib/utils";

const API_METHOD_STYLES = {
  GET: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  POST: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  PUT: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  PATCH:
    "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  DELETE: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-400",
  HEAD: "border-muted-foreground/25 bg-muted text-muted-foreground",
  OPTIONS: "border-muted-foreground/25 bg-muted text-muted-foreground",
} as const;

export function ApiMethodBadge({
  method,
  compact = false,
}: {
  method: string;
  compact?: boolean;
}) {
  const normalizedMethod = normalizeApiMethod(method);
  if (!normalizedMethod) return null;

  return (
    <span
      aria-label={`${normalizedMethod} method`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded border font-mono font-semibold",
        compact
          ? "min-w-10 px-1 py-0.5 text-[0.6rem] leading-none"
          : "px-2 py-1 text-xs leading-none",
        API_METHOD_STYLES[normalizedMethod]
      )}
    >
      {normalizedMethod}
    </span>
  );
}

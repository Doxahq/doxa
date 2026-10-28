import type { VersionObjectFetcher } from "@doxahq/docs-engine";

/** The loopback bindings of this Worker that the runtime calls. */
export interface DocsRuntimeExports {
  readonly DocsBlobCache?: VersionObjectFetcher;
}

declare global {
  // `ctx.exports` exists from compatibility date 2025-11-17. The installed
  // workers-types predates it. Remove this declaration when it has it.
  interface ExecutionContext<Props = unknown> {
    readonly exports?: DocsRuntimeExports;
  }
}

/**
 * The tiered blob cache entrypoint of the current request, read from its own
 * `ctx`. Null where the runtime gives no loopback bindings, for example in
 * tests; the reader then reads R2.
 */
export function blobCacheOf(
  ctx: ExecutionContext,
): VersionObjectFetcher | null {
  return ctx.exports?.DocsBlobCache ?? null;
}

import { z } from "zod";

/**
 * Tracing of one dispatcher → docs-runtime `request` RPC.
 *
 * The dispatcher creates the trace (a random UUID and the caller name) for
 * every call it sends. It never copies a trace from renderer input. When the
 * call carries a valid trace, docs-runtime answers with `timing` and logs the
 * trace ID, so one call can be followed from `docs_renderer_load` to
 * `docs_runtime_reads`. Both fields are optional: an old dispatcher sends no
 * trace and gets the old answer, and an old docs-runtime ignores the trace.
 * See docs/current/production-docs-content-injection.md, "Route-Data Trace".
 */

/** Who sent the call: the route-data prefetch, the renderer's content binding, or the pre-render plan. */
export const DOCS_RUNTIME_CALLERS = ["prefetch", "content", "plan"] as const;

export const docsRuntimeCallerSchema = z.enum(DOCS_RUNTIME_CALLERS);

export type DocsRuntimeCaller = z.infer<typeof docsRuntimeCallerSchema>;

export const docsRuntimeTraceSchema = z.object({
  id: z.uuid(),
  caller: docsRuntimeCallerSchema,
});

export type DocsRuntimeTrace = z.infer<typeof docsRuntimeTraceSchema>;

const durationMsSchema = z.number().finite().nonnegative();
const countSchema = z.number().int().nonnegative();

/** The docs-runtime isolate that answered: a random ID, its call count and age. */
export const docsRuntimeIsolateFactsSchema = z.object({
  id: z.string().min(1).max(64),
  requests: countSchema,
  ageMs: durationMsSchema,
});

export type DocsRuntimeIsolateFacts = z.infer<
  typeof docsRuntimeIsolateFactsSchema
>;

/**
 * How docs-runtime spent one traced call. Durations are wall-clock
 * milliseconds inside docs-runtime. `firstReadMs` (call start to the end of
 * the first storage read) is absent when the call read no storage.
 * `responseBytes` is the JSON size of the answer data, for `getRouteData` only.
 */
export const docsRuntimeCallTimingSchema = z.object({
  manifestMs: durationMsSchema,
  operationMs: durationMsSchema,
  firstReadMs: durationMsSchema.optional(),
  totalMs: durationMsSchema,
  reads: countSchema,
  r2Reads: countSchema,
  readMs: durationMsSchema,
  responseBytes: countSchema.optional(),
  versionColdInIsolate: z.boolean(),
  isolate: docsRuntimeIsolateFactsSchema,
});

export type DocsRuntimeCallTiming = z.infer<typeof docsRuntimeCallTimingSchema>;

/** Returns the timing of a docs-runtime answer, or undefined when it has none or it is invalid. */
export function readDocsRuntimeCallTiming(
  value: unknown,
): DocsRuntimeCallTiming | undefined {
  const parsed = docsRuntimeCallTimingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Returns a valid trace, or undefined. docs-runtime never trusts an invalid one. */
export function readDocsRuntimeTrace(
  value: unknown,
): DocsRuntimeTrace | undefined {
  const parsed = docsRuntimeTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

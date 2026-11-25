import type { AnyProductEvent, ProductAnalytics, ProductEventProperties } from "@doxahq/analytics";
import type { GenerationStopReason } from "@doxahq/contracts";
import type { Env } from "../env";
import { GenerationAnalyticsRepository, type GenerationEndFacts, type GenerationEndFactsStore } from "../repositories/generation-analytics";
import { productAnalyticsOf } from "./analytics/product-analytics";

type GenerationTrigger = ProductEventProperties<"generation_started">["trigger"];

/** Who started a run, and from which surface. A merge run has none: it counts for the project owner. */
export interface GenerationStartedBy {
  readonly userId: string;
  readonly via: NonNullable<ProductEventProperties<"generation_started">["via"]>;
}

/** `generation_started`, once the job is queued. A run without a baseline is cold: a full generation. */
export function captureGenerationStarted(
  analytics: ProductAnalytics,
  input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly trigger: GenerationTrigger;
    readonly baselineVersionId: string | null;
    readonly startedBy?: GenerationStartedBy | undefined;
  },
): void {
  analytics.capture({
    name: "generation_started",
    distinctId: input.startedBy?.userId ?? input.ownerUserId,
    properties: {
      trigger: input.trigger,
      run: input.baselineVersionId === null ? "cold" : "warm",
      ...(input.startedBy ? { via: input.startedBy.via } : {}),
    },
    groups: { project: input.projectId },
  });
}

/** What the end path knows that the job row does not. */
export interface GenerationEndDetails {
  /** Pages that the run wrote (`regeneratedPageCount`). */
  readonly pagesWritten?: number;
  /** Why the credit meter stopped the run: a machine code. */
  readonly stopReason?: GenerationStopReason;
}

type GenerationOutcome = ProductEventProperties<"generation_finished">["outcome"];
const ENDED: ReadonlySet<GenerationEndFacts["status"]> = new Set<GenerationOutcome>(["succeeded", "failed", "cancelled", "stopped_credits"]);

function isEnded(status: GenerationEndFacts["status"]): status is GenerationOutcome {
  return ENDED.has(status);
}

/**
 * `generation_finished` for a run that reached an end state, and
 * `doxabot_run_finished` too for a pull request run. The outcome is the
 * job's stored status, so each end path reports the same way.
 */
export function generationFinishedEvents(facts: GenerationEndFacts | null, details: GenerationEndDetails = {}): AnyProductEvent[] {
  if (!facts || !isEnded(facts.status)) return [];
  const outcome = facts.status;
  const groups = { project: facts.projectId };
  const finished: AnyProductEvent = {
    name: "generation_finished",
    distinctId: facts.userId,
    properties: {
      trigger: facts.trigger,
      outcome,
      duration_s: Math.max(0, (facts.endedAt.getTime() - facts.createdAt.getTime()) / 1000),
      ...(details.pagesWritten === undefined ? {} : { pages_written: details.pagesWritten }),
      ...(details.stopReason ? { error_code: details.stopReason } : {}),
    },
    groups,
  };
  if (facts.trigger !== "doxabot") return [finished];
  return [
    finished,
    {
      name: "doxabot_run_finished",
      distinctId: facts.userId,
      properties: { outcome, ...(details.pagesWritten === undefined ? {} : { pages_changed: details.pagesWritten }) },
      groups,
    },
  ];
}

/**
 * Reports a finished run in the background: the end of a run never waits
 * for analytics, `flush()` waits for the read, and a failed read sends
 * nothing. Without analytics it reads nothing.
 */
export function reportGenerationFinished(
  deps: { readonly facts: GenerationEndFactsStore; readonly analytics: ProductAnalytics },
  jobId: string,
  details: GenerationEndDetails = {},
): void {
  deps.analytics.captureWhenReady(async () => generationFinishedEvents(await deps.facts.endFacts(jobId), details));
}

export function reportGenerationFinishedInBackground(env: Env, jobId: string, details: GenerationEndDetails = {}): void {
  reportGenerationFinished({ facts: new GenerationAnalyticsRepository(env), analytics: productAnalyticsOf(env) }, jobId, details);
}

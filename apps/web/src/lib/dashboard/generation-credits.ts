import {
  generationStopReasonSchema,
  type GenerationJobDto,
  type GenerationStopReason,
  type JobEventDto,
} from "@doxahq/contracts"
import { GENERATION_CREDITS_EVENT_TYPE, generationCreditsEventDataSchema } from "@doxahq/contracts/billing"

import { creditsToUsd, formatCredits } from "~/lib/dashboard/billing-model"

/** The job event that ends a run the credit meter stopped (`markStoppedCredits` in the API). */
export const CREDITS_STOPPED_EVENT_TYPE = "credits_stopped"

/** The live credit meter of one run (billing spec 10.5, "What the customer sees"). */
export interface GenerationCreditMeter {
  /** The credits of the whole job, over every try of a continued run. */
  usedCredits: number
  /** The cap of the current try. */
  capCredits: number
  /** "This run's cap: 3,000 credits" */
  capLine: string
  /** "$2.40 from pay-as-you-go", or null when the grants paid for all of it. */
  paygLine: string | null
}

export function isCreditsEvent(event: Pick<JobEventDto, "type">): boolean {
  return event.type === GENERATION_CREDITS_EVENT_TYPE
}

/**
 * The lines of the generation log. The `credits` events are the meter's
 * data, not log lines: they arrive every 5 seconds, and in shadow mode the
 * customer must not see them at all.
 */
export function generationLogEvents(events: readonly JobEventDto[]): JobEventDto[] {
  return events.filter((event) => !isCreditsEvent(event))
}

/**
 * The meter from the newest valid `credits` event. Null without one, or when
 * the newest one is a shadow event: shadow mode is invisible to the customer.
 */
export function readCreditMeter(events: readonly JobEventDto[]): GenerationCreditMeter | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || !isCreditsEvent(event)) continue
    const parsed = generationCreditsEventDataSchema.safeParse(event.data)
    if (!parsed.success) continue
    const data = parsed.data
    if (data.shadow) return null
    return {
      // The whole job, so a continued run never counts down. Older events have only the try.
      usedCredits: data.jobUsedCredits ?? data.usedCredits,
      capCredits: data.capCredits,
      capLine: `This run's cap: ${formatCredits(data.capCredits)} credits`,
      paygLine: data.fromPaygCredits > 0 ? `${creditsToUsd(data.fromPaygCredits)} from pay-as-you-go` : null,
    }
  }
  return null
}

/** Why and where a `stopped_credits` run ended (billing spec 10.6). */
export interface GenerationCreditsStop {
  /** A meter stop, or null when the event names another billing code. */
  reason: GenerationStopReason | null
  /** Pages written before the stop, when the worker reported them. */
  finishedPageCount: number | null
}

export function readCreditsStop(events: readonly JobEventDto[]): GenerationCreditsStop {
  const event = [...events].reverse().find((item) => item.type === CREDITS_STOPPED_EVENT_TYPE)
  const reason = generationStopReasonSchema.safeParse(event?.data?.reason)
  const pages = event?.data?.finishedPageCount
  return {
    reason: reason.success ? reason.data : null,
    finishedPageCount: typeof pages === "number" && Number.isInteger(pages) && pages >= 0 ? pages : null,
  }
}

export function isStoppedForCredits(job: Pick<GenerationJobDto, "status"> | null | undefined): boolean {
  return job?.status === "stopped_credits"
}

/** The billing action of a stopped run: the cap for `credit_cap`, else the monthly limit. */
export function creditsStopAction(reason: GenerationStopReason | null): { label: string; hash: "caps" | "payg" } {
  return reason === "credit_cap"
    ? { label: "Raise the cap", hash: "caps" }
    : { label: "Raise the monthly limit", hash: "payg" }
}

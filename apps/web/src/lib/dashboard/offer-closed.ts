import { z } from "zod"

import { ApiRequestError } from "~/lib/api-errors"

const offerClosedSchema = z.object({ code: z.literal("offer_closed"), price: z.string().min(1) })

/** The new price key of a 409 `offer_closed` answer (spec 7.5 rule 2), else null. */
export function offerClosedPrice(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null
  const parsed = offerClosedSchema.safeParse(error.details)
  return parsed.success ? parsed.data.price : null
}

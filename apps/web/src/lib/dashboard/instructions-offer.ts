import type { QueryClient } from "@tanstack/react-query"

import { projectGenerationsQueryOptions } from "~/lib/queries/dashboard"
import { doxabotInstructionsQueryOptions } from "~/lib/queries/doxabot-instructions"

/**
 * A project's first generation sets the shape of its docs, so a person who can
 * change the instructions gets the chance to write them first.
 */
export function shouldOfferInstructions(input: {
  canConfigureInstructions: boolean
  hasGenerations: boolean
  hasInstructions: boolean
}): boolean {
  return input.canConfigureInstructions && !input.hasGenerations && !input.hasInstructions
}

/** A failed lookup returns false: the offer must never stop a generation. */
export async function loadInstructionsOffer(
  queryClient: QueryClient,
  projectId: string,
  canConfigureInstructions: boolean,
): Promise<boolean> {
  if (!canConfigureInstructions) return false
  try {
    const [generations, instructions] = await Promise.all([
      queryClient.ensureInfiniteQueryData(projectGenerationsQueryOptions(projectId)),
      queryClient.ensureQueryData(doxabotInstructionsQueryOptions(projectId)),
    ])
    return shouldOfferInstructions({
      canConfigureInstructions,
      hasGenerations: generations.pages.some((page) => page.generations.length > 0),
      hasInstructions: instructions.current !== null,
    })
  } catch {
    return false
  }
}

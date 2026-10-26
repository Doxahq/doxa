import {
  resolveDocumentationBrief,
  type ResolvedDocumentationGenerationBrief,
} from "@doxahq/agent";
import type { ContainerGenerateRequest } from "@doxahq/contracts";

/**
 * The documentation brief of a run. Every stage takes its brief from here, so
 * project instructions enter in one place: the Doxabot instructions that the
 * API attached to the request, or none.
 */
export function resolveRunBrief(
  input: Pick<ContainerGenerateRequest, "doxabotInstructions">,
): ResolvedDocumentationGenerationBrief {
  return resolveDocumentationBrief({
    target: { kind: "public" },
    ...(input.doxabotInstructions ? { projectInstructions: input.doxabotInstructions } : {}),
  });
}

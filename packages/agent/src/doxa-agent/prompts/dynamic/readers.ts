import { documentationReadersOf } from "../../documentation-policy";
import type { PromptRenderContext } from "./types";

/**
 * The prompt line for the readers of a run. Most fixed rules assume readers
 * outside the team. With the internal team as the reader, which only the
 * owner's fixed choice selects, those rules would forbid what the team needs.
 */
export function lineForReaders(
  context: Pick<PromptRenderContext, "documentationBrief">,
  lines: { public: string; team: string },
): string {
  return documentationReadersOf(context.documentationBrief) === "team" ? lines.team : lines.public;
}

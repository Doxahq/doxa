import {
  resolveDocumentationBrief,
  type ResolvedDocumentationGenerationBrief,
} from "@doxahq/agent";

/**
 * The documentation brief of a run. Every stage takes its brief from here, so
 * project or run instructions enter in one place when they exist. Today each
 * run writes public documentation with no added context.
 */
export function resolveRunBrief(): ResolvedDocumentationGenerationBrief {
  return resolveDocumentationBrief({ target: { kind: "public" } });
}

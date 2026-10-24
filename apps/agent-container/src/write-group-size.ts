import { templateRenderedPageIds, type DocumentationStructure } from "@doxahq/agent";
import { MAX_WRITE_GROUP_PAGES } from "@doxahq/contracts";
import { GenerationStageInvariantError } from "./generation-stage-errors";

/**
 * Only a group of template-rendered pages may hold more than
 * `MAX_WRITE_GROUP_PAGES` pages. Model pages keep the smaller groups, so one
 * write step never holds more model work than its timeout allows.
 */
export function assertWriteGroupSize(
  structure: DocumentationStructure,
  pageIds: readonly string[],
): void {
  if (pageIds.length <= MAX_WRITE_GROUP_PAGES) return;

  const templatePageIds = new Set(templateRenderedPageIds(structure));
  const modelPageCount = pageIds.filter((pageId) => !templatePageIds.has(pageId)).length;
  if (modelPageCount === 0) return;

  throw new GenerationStageInvariantError(
    `A write group of ${pageIds.length} pages holds ${modelPageCount} model-written pages. ` +
      `Only template-rendered pages may exceed ${MAX_WRITE_GROUP_PAGES} pages in one group.`,
    "write_group_too_large",
  );
}

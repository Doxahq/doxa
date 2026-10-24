import type { IncrementalGenerationPlan, PreviousPageText } from "@doxahq/contracts";

type PageEdits = NonNullable<IncrementalGenerationPlan["pageEdits"]>;

/**
 * The published versions of the pages in one write group that the plan
 * edits, read from the baseline artifacts. A page whose artifact is missing
 * is left out, so its writer writes it from the source alone.
 */
export async function readPreviousPages(
  read: (key: string) => Promise<string | null>,
  pageEdits: PageEdits | undefined,
  pageIds: readonly string[],
): Promise<Record<string, PreviousPageText>> {
  if (!pageEdits) return {};
  const entries = await Promise.all(
    pageIds.map(async (pageId) => {
      const edit = pageEdits[pageId];
      if (!edit) return null;
      const content = await read(edit.artifactKey);
      return content === null ? null : ([pageId, { content, changedSources: edit.changedSources }] as const);
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

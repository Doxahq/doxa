import {
  ensureReferenceSections,
  flattenStructure,
  referenceIdentityKey,
  referenceSectionDefaultsFromAnswers,
  stablePageId,
  type DocumentationStructure,
  type ProjectAnalysis,
} from "@doxahq/agent";

export interface StructurePatch {
  structure: DocumentationStructure;
  /** Reference pages that the new analysis adds, such as a new endpoint. */
  addedPageIds: string[];
  /** Reference pages that the new analysis no longer has. */
  removedPageIds: string[];
}

/**
 * The published structure with its REST and SDK reference sections rebuilt
 * from the new analysis. No model is called: every editorial page stays as
 * published, and each reference page keeps its published route and name.
 *
 * A reference page that the previous analysis already implied, but that the
 * published structure lacks, was merged or dropped on purpose by an earlier
 * structure review, so the patch leaves it out. Only what the code adds since
 * comes in. An analysis without reference surfaces leaves the published
 * sections as they are, rather than removing them.
 */
export function patchPublishedStructure(
  published: DocumentationStructure,
  analysis: ProjectAnalysis,
  previousAnalysis?: ProjectAnalysis,
): StructurePatch {
  const defaults = referenceSectionDefaultsFromAnswers({});
  const removedEarlier = previousAnalysis
    ? keysRemovedEarlier(published, previousAnalysis, defaults)
    : new Set<string>();
  const structure = withoutReferenceKeys(
    ensureReferenceSections(published, analysis, defaults, published),
    removedEarlier,
  );
  const before = new Set(flattenStructure(published).map(stablePageId));
  const after = new Set(flattenStructure(structure).map(stablePageId));
  return {
    structure,
    addedPageIds: [...after].filter((pageId) => !before.has(pageId)),
    removedPageIds: [...before].filter((pageId) => !after.has(pageId)),
  };
}

/** The reference pages that the previous analysis implied and the published structure lacks. */
function keysRemovedEarlier(
  published: DocumentationStructure,
  previousAnalysis: ProjectAnalysis,
  defaults: ReturnType<typeof referenceSectionDefaultsFromAnswers>,
): Set<string> {
  const implied = referenceKeys(ensureReferenceSections(published, previousAnalysis, defaults, published));
  const kept = referenceKeys(published);
  return new Set([...implied].filter((key) => !kept.has(key)));
}

function referenceKeys(structure: DocumentationStructure): Set<string> {
  const keys = new Set<string>();
  for (const section of structure.sections) {
    for (const page of section.pages) {
      const key = referenceIdentityKey(page);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function withoutReferenceKeys(
  structure: DocumentationStructure,
  keys: ReadonlySet<string>,
): DocumentationStructure {
  if (keys.size === 0) return structure;
  return {
    sections: structure.sections.map((section) => ({
      ...section,
      pages: section.pages.filter((page) => !keys.has(referenceIdentityKey(page) ?? "")),
    })),
  };
}

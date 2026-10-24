/**
 * The documentation structure helpers that run in a Cloudflare Worker: no
 * Node modules, no model or file system code. `scripts/assert-dist.mjs`
 * fails the build when this entry imports a Node module.
 */

export type { DocPage, DocSection, DocumentationStructure } from "./types";
export {
  flattenStructure,
  stablePageId,
  type FlattenedStructurePage,
} from "./doxa-agent/structure-utils";
export {
  normalizeRoute,
  pageOutputPath,
  routeFromOutputPath,
  sectionFolder,
} from "./doxa-agent/route-registry";
export {
  seedStructureFromSite,
  type SeedNavigationNode,
  type SeedPage,
  type SeedSection,
} from "./doxa-agent/seed-structure";
export { isDocumentationStructure } from "./state/structure-guard";
export {
  explainedBaselineHashes,
  hashPageInputs,
  legacyPageInputFields,
  pageInputFields,
  type PageInputFields,
} from "./state/page-input-hash";
export { hashJson, stableStringify } from "./utils/stable-hash";
export {
  deterministicRendererIdFor,
  templateRenderedPageIds,
} from "./doxa-agent/page-renderer-kind";

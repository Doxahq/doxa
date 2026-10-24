import { deterministicRendererIdFor } from "../doxa-agent/page-renderer-kind";
import {
  flattenStructure,
  stablePageId,
  type FlattenedStructurePage,
} from "../doxa-agent/structure-utils";
import type { DocumentationStructure } from "../types";
import { hashJson } from "../utils/stable-hash";
import { evidencePaths, normalizedBrief } from "./page-input";

/** The fields of a page that its input hash covers. */
export type PageInputFields = (target: FlattenedStructurePage) => Record<string, unknown>;

/**
 * What the writer needs to write a page. Evidence counts as its file paths and
 * the description as its words, so a planner that only relabels the evidence
 * or reflows the description does not make the page be written again.
 */
export const pageInputFields: PageInputFields = (target) => ({
  pageId: stablePageId(target),
  sectionTitle: target.sectionTitle,
  title: target.page.title,
  description: normalizedBrief(target.page.description),
  outputPath: target.path,
  group: target.page.group,
  sourceEvidence: evidencePaths(target.page.sourceEvidence),
  collectionId: target.page.collectionId,
  collectionItemId: target.page.collectionItemId,
  reference: target.page.reference,
  // Only template-rendered pages carry this key, so the hash of every
  // model-written page stays the same. A template page never reuses a page
  // the model writer stored, and the model writer never reuses a template page.
  renderer: deterministicRendererIdFor(target.page),
});

/**
 * The page input rule before evidence and descriptions were normalized
 * (2026-10-17). Baselines stored before then use it, and
 * {@link explainedBaselineHashes} recognizes them.
 */
export const legacyPageInputFields: PageInputFields = (target) => ({
  pageId: stablePageId(target),
  sectionTitle: target.sectionTitle,
  title: target.page.title,
  description: target.page.description,
  outputPath: target.path,
  group: target.page.group,
  sourceEvidence: target.page.sourceEvidence ?? [],
  collectionId: target.page.collectionId,
  collectionItemId: target.page.collectionItemId,
  reference: target.page.reference,
  renderer: deterministicRendererIdFor(target.page),
});

/**
 * The hashes to compare a baseline's pages with, keyed by page ID. A stored
 * hash that the baseline structure explains, under the current rule or the
 * legacy one, becomes the current rule's hash, so a change of the rule
 * rewrites no page. A stored hash that the structure does not explain stays
 * as it is: the page was written from other inputs, for example by another
 * renderer, and is written again.
 */
export function explainedBaselineHashes(input: {
  stored: Readonly<Record<string, string>>;
  current: Readonly<Record<string, string>>;
  legacy: Readonly<Record<string, string>>;
}): Record<string, string> {
  const hashes: Record<string, string> = { ...input.stored };
  for (const [id, storedHash] of Object.entries(input.stored)) {
    const current = input.current[id];
    if (current !== undefined && (storedHash === current || storedHash === input.legacy[id])) {
      hashes[id] = current;
    }
  }
  return hashes;
}

/**
 * The input hash of every page of a structure, by stable page ID, with Web
 * Crypto. The sync hashes of the generation service are the same.
 */
export async function hashPageInputs(
  structure: DocumentationStructure,
  fieldsOf: PageInputFields = pageInputFields,
): Promise<Record<string, string>> {
  const targets = flattenStructure(structure);
  const hashes = await Promise.all(targets.map((target) => hashJson(fieldsOf(target))));
  return Object.fromEntries(targets.map((target, index) => [stablePageId(target), hashes[index]]));
}

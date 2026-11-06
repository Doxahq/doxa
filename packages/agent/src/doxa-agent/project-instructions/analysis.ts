import {
  describeDoxabotReaders,
  describeDoxabotVoice,
  type DoxabotInstructions,
} from "@doxahq/contracts";

import type {
  DocumentationGenerationBrief,
  ProjectAnalysis,
  PublicEditorialBrief,
} from "../../types";
import { turnedOffTypeOfPage } from "../../utils/planned-page-types";
import {
  applyReferenceInstructions,
  excludedPathMatcher,
  isOnlyUnder,
  withKeptEvidence,
  type PathMatcher,
} from "../reference-instructions";
import { READER_AUDIENCE } from "./reader-audience";
import { turnedOffPageTypes } from "./stage-guidance";

type InstructionsBrief = Pick<DocumentationGenerationBrief, "projectInstructions">;

const EMPTY_EDITORIAL_BRIEF: PublicEditorialBrief = {
  intendedReaders: [],
  readerGoals: [],
  focusAreas: [],
  deprioritizedAreas: [],
  preferredTerminology: [],
};

/**
 * The analysis with the owner's choices in it, so every later step reads them
 * as facts: the planner, the writer handoff, and the checks. A model can miss a
 * line in a prompt, but it cannot change what code writes here.
 */
export function applyProjectInstructions(
  analysis: ProjectAnalysis,
  brief: InstructionsBrief | undefined,
): ProjectAnalysis {
  const withReference = applyReferenceInstructions(withoutTurnedOffItemCounts(analysis), brief);
  const instructions = brief?.projectInstructions?.instructions;
  if (!instructions) return withReference;

  const isExcluded = excludedPathMatcher(instructions.doNotDocument);
  const inScope = isExcluded ? withoutExcludedPaths(withReference, isExcluded) : withReference;
  return withOwnerEditorialChoices(
    withoutTurnedOffCollectionItems(inScope, instructions),
    instructions,
  );
}

type CanonicalWorkflow = NonNullable<ProjectAnalysis["documentationIntent"]>["canonicalWorkflows"][number];

function withoutExcludedPaths(analysis: ProjectAnalysis, isExcluded: PathMatcher): ProjectAnalysis {
  const isKept = (path: string) => !isExcluded(path);
  const intent = analysis.documentationIntent;

  return {
    ...analysis,
    entryPoints: analysis.entryPoints.filter(isKept),
    keyFiles: analysis.keyFiles.filter(isKept),
    configFiles: analysis.configFiles.filter((config) => isKept(config.path)),
    repositoryDocuments: analysis.repositoryDocuments?.filter((document) => isKept(document.path)),
    documentationCollections: analysis.documentationCollections?.flatMap((collection) => {
      const items = collection.items
        .filter((item) => !isOnlyUnder(isExcluded, item.sourceEvidence, collection.sourceEvidence))
        .map((item) => withKeptEvidence(item, isExcluded));
      return items.length > 0 ? [{ ...withKeptEvidence(collection, isExcluded), items }] : [];
    }),
    ...(intent
      ? {
          documentationIntent: {
            ...intent,
            canonicalWorkflows: intent.canonicalWorkflows.flatMap((workflow) =>
              workflowWithoutExcludedPaths(workflow, isKept) ?? []
            ),
          },
        }
      : {}),
  };
}

/** A workflow that rests only on excluded files goes. Another one loses only those files. */
function workflowWithoutExcludedPaths(
  workflow: CanonicalWorkflow,
  isKept: (path: string) => boolean,
): CanonicalWorkflow | null {
  const sourceEvidence = workflow.sourceEvidence.filter(isKept);
  if (workflow.sourceEvidence.length > 0 && sourceEvidence.length === 0) return null;
  return { ...workflow, sourceEvidence, requiredFiles: workflow.requiredFiles.filter(isKept) };
}

/**
 * Code adds a page for each collection item, after the plan filter, and the
 * review may not drop it. An item whose title names a page type that the
 * owner turned off goes here, so no such page is added. The collection keeps
 * the count of the items it lost, so it still meets the minimum that gives its
 * other items their pages.
 */
function withoutTurnedOffCollectionItems(
  analysis: ProjectAnalysis,
  instructions: DoxabotInstructions,
): ProjectAnalysis {
  const turnedOff = new Set(turnedOffPageTypes(instructions));
  if (turnedOff.size === 0 || !analysis.documentationCollections) return analysis;
  return {
    ...analysis,
    documentationCollections: analysis.documentationCollections.flatMap((collection) => {
      const items = collection.items.filter((item) => !turnedOffTypeOfPage(item, turnedOff));
      const turnedOffItemCount = collection.items.length - items.length;
      if (items.length === 0) return [];
      return [turnedOffItemCount > 0 ? { ...collection, items, turnedOffItemCount } : collection];
    }),
  };
}

/**
 * Only this step sets the count of turned-off items, from the instructions of
 * the run. A count in the incoming analysis (written by a model, or by a run
 * with other instructions) is dropped first.
 */
function withoutTurnedOffItemCounts(analysis: ProjectAnalysis): ProjectAnalysis {
  const collections = analysis.documentationCollections;
  if (!collections?.some((collection) => collection.turnedOffItemCount !== undefined)) return analysis;
  return {
    ...analysis,
    documentationCollections: collections.map(({ turnedOffItemCount: _dropped, ...collection }) => collection),
  };
}

/**
 * The paths that later steps keep out of the pages: the model's repo-only
 * paths, then the owner's "Do not document" folders. For the internal team the
 * analysis prompt asks only for generated or vendored paths, because tests,
 * demos, and contributor tooling are documentation for the team.
 */
function ownerInternalOnlyPaths(modelPaths: readonly string[], instructions: DoxabotInstructions): string[] {
  return uniqueInOrder([
    ...modelPaths,
    ...instructions.doNotDocument.flatMap(folderOfGlob),
  ]);
}

/**
 * The folder of a glob such as `internal/**`. Readers of `internalOnlyPaths`
 * compare by prefix, so a glob with another wildcard has no entry there: its
 * prefix would also cover files that the glob does not match. Code already
 * removed the files that such a glob matches from every list of the analysis.
 */
function folderOfGlob(glob: string): string[] {
  const path = glob.replace(/\/\*\*$/, "").replace(/\/+$/, "");
  return /[*?{}[\]]/.test(path) ? [] : [`${path}/`];
}

function withOwnerEditorialChoices(
  analysis: ProjectAnalysis,
  instructions: DoxabotInstructions,
): ProjectAnalysis {
  const intent = analysis.documentationIntent;
  const editorial = analysis.publicEditorialBrief ?? EMPTY_EDITORIAL_BRIEF;

  return {
    ...analysis,
    publicEditorialBrief: {
      ...editorial,
      intendedReaders: [describeDoxabotReaders(instructions.audience)],
      preferredTone: describeDoxabotVoice(instructions.voice),
      preferredTerminology: withOwnerTerminology(editorial.preferredTerminology, instructions),
    },
    ...(intent
      ? {
          documentationIntent: {
            ...intent,
            audience: READER_AUDIENCE[instructions.audience.reader],
            internalOnlyPaths: ownerInternalOnlyPaths(intent.internalOnlyPaths, instructions),
            consumerTerminology: withOwnerTerminology(intent.consumerTerminology, instructions),
          },
        }
      : {}),
  };
}

/** The owner's terms first, then the others that the owner does not avoid. */
function withOwnerTerminology(terms: readonly string[], instructions: DoxabotInstructions): string[] {
  const avoided = new Set(instructions.terminology.flatMap((entry) => entry.avoid).map((term) => term.toLowerCase()));
  return uniqueInOrder([
    ...instructions.terminology.map((entry) => entry.use),
    ...terms.filter((term) => !avoided.has(term.toLowerCase())),
  ]);
}

function uniqueInOrder(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

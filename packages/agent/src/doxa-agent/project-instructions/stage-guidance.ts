import {
  DOXABOT_PAGE_TYPE_LABELS,
  DOXABOT_PAGE_TYPES,
  type DoxabotInstructions,
  type DoxabotPageType,
} from "@doxahq/contracts";

import { READER_AUDIENCE } from "./reader-audience";

/** The steps of a run that call a model. A repair changes text that a writer wrote. */
export type InstructionStep =
  | "exploration"
  | "analysis"
  | "incremental-analysis"
  | "structure"
  | "structure-review"
  | "ordering"
  | "writer"
  | "repair";

/** The page types that the owner turned off. */
export function turnedOffPageTypes(instructions: Pick<DoxabotInstructions, "pageTypes">): DoxabotPageType[] {
  return DOXABOT_PAGE_TYPES.filter((type) => !instructions.pageTypes.includes(type));
}

function labels(types: readonly DoxabotPageType[]): string {
  return types.map((type) => DOXABOT_PAGE_TYPE_LABELS[type]).join(", ");
}

interface InstructionFacts {
  instructions: DoxabotInstructions;
  turnedOff: readonly DoxabotPageType[];
  /** The turned-off types other than the API reference, which has lines of its own. */
  editorialOff: readonly DoxabotPageType[];
  referenceOff: boolean;
  hasExcludedPaths: boolean;
  hasCodeLanguages: boolean;
}

function when(condition: boolean, line: string): string[] {
  return condition ? [line] : [];
}

function explorationLines(facts: InstructionFacts): string[] {
  return [
    "Explore for the readers named above: look first for what they need to do with the product.",
    ...when(facts.hasCodeLanguages, "Look for usage, examples, and clients in the code languages named above, so that later steps can show real examples in them."),
    ...when(facts.hasExcludedPaths, "Read the paths under \"Do not document\" only as far as you need to understand the rest. Report nothing from them as a feature or a workflow."),
    ...when(facts.referenceOff, "The API reference is off: do not list endpoints, parameters, or exports."),
    ...when(facts.editorialOff.length > 0, `Gather nothing only for these page types: ${labels(facts.editorialOff)}.`),
  ];
}

function analysisLines(facts: InstructionFacts): string[] {
  return [
    "Write the whole analysis for the readers, the tone, and the terminology named above.",
    `documentationIntent.audience must be "${READER_AUDIENCE[facts.instructions.audience.reader]}". publicEditorialBrief.intendedReaders and preferredTone must state the owner's choices, and preferredTerminology must hold the terms to use.`,
    ...when(facts.referenceOff, "Leave referenceSurfaces out."),
    ...when(facts.hasExcludedPaths, "Leave what exists only under the \"Do not document\" paths out of publicInterfaces, keyFeatures, canonicalWorkflows, and documentationCollections, and list those paths in documentationIntent.internalOnlyPaths."),
    ...when(facts.hasCodeLanguages, "Write canonicalWorkflows in the first named code language that the repository supports."),
    ...when(facts.editorialOff.length > 0, `publicEditorialBrief.focusAreas must not ask for these page types: ${labels(facts.editorialOff)}.`),
  ];
}

function planLines(facts: InstructionFacts): string[] {
  return [
    "Write titles and descriptions in the owner's terminology, for the readers named above, at the depth that their level needs.",
    "Apply the owner's rules and context to what the plan covers.",
    ...when(facts.turnedOff.length > 0, `Plan no page of these types, even where a rule in this prompt lists one: ${labels(facts.turnedOff)}. Doxa removes such a page.`),
    ...when(facts.turnedOff.length > 0, `Set pageType on every page: "overview" for the landing page, or one of ${facts.instructions.pageTypes.map((type) => `"${type}"`).join(", ")}.`),
    ...when(facts.referenceOff, "Plan no reference section, and set reference on no page."),
    ...when(facts.hasExcludedPaths, "Plan no page from the \"Do not document\" paths, and cite no file under them in sourceEvidence."),
  ];
}

function reviewLines(facts: InstructionFacts): string[] {
  return [
    "Judge each page for the readers named above, and apply the owner's rules and context.",
    ...when(facts.turnedOff.length > 0, `Drop every page of these types, even where a rule in this prompt keeps it: ${labels(facts.turnedOff)}.`),
    ...when(facts.hasExcludedPaths, "Drop a page that exists only to document the \"Do not document\" paths."),
  ];
}

function writerLines(facts: InstructionFacts): string[] {
  return [
    "Follow the tone, the address, and the terminology named above on every line, in headings and component text too. Keep a term from the \"not\" side only inside a product name, a code identifier, or quoted text.",
    "Follow the owner's rules on every page.",
    ...when(facts.hasCodeLanguages, "Show code examples in the named code languages, in that order inside <Tabs>. Show another language only when the repository has no example in a named one."),
    ...when(facts.editorialOff.length > 0, `Add no section of these page types, even where a page template asks for one: ${labels(facts.editorialOff)}.`),
    ...when(facts.hasExcludedPaths, "Do not mention files, folders, or features that exist only under the \"Do not document\" paths."),
    "validate_page reports a break of these instructions. Fix each one it reports.",
  ];
}

const STEP_LINES: Readonly<Record<InstructionStep, (facts: InstructionFacts) => string[]>> = {
  exploration: explorationLines,
  analysis: analysisLines,
  "incremental-analysis": analysisLines,
  structure: planLines,
  "structure-review": reviewLines,
  ordering: () => ["Order the pages for the readers named above: what they need first comes first."],
  writer: writerLines,
  repair: () => ["Keep following these instructions in what you change, and add nothing that breaks them."],
};

/**
 * What the instructions mean for one step. Code writes every line and repeats
 * no owner text, so it adds nothing that an owner could use to steer a model
 * outside the fenced block. The same instructions give the same lines, so the
 * lines stay inside the cached prefix of the prompt.
 */
export function renderInstructionGuidance(
  instructions: DoxabotInstructions,
  step: InstructionStep,
): string {
  const turnedOff = turnedOffPageTypes(instructions);
  const lines = STEP_LINES[step]({
    instructions,
    turnedOff,
    editorialOff: turnedOff.filter((type) => type !== "reference"),
    referenceOff: turnedOff.includes("reference"),
    hasExcludedPaths: instructions.doNotDocument.length > 0,
    hasCodeLanguages: instructions.codeLanguages.length > 0,
  });

  return [
    "HOW THE PROJECT INSTRUCTIONS APPLY TO THIS STEP",
    "They shape every step of this run, from the first read of the code to the last page. Where another rule in this prompt names a page type, a reader, or a section that they rule out, follow the instructions.",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

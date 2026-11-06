import type { DoxabotPageType } from "@doxahq/contracts";

import type {
  DocPage,
  DocumentationGenerationBrief,
  DocumentationStructure,
  PlanRemoval,
  PlanRemovalReason,
} from "../../types";
import { turnedOffTypeOfPage } from "../../utils/planned-page-types";
import { excludedPathMatcher, type PathMatcher } from "../reference-instructions";
import { turnedOffPageTypes } from "./stage-guidance";

type InstructionsBrief = Pick<DocumentationGenerationBrief, "projectInstructions">;

export type { PlanRemoval, PlanRemovalReason } from "../../types";

export interface FilteredPlan {
  structure: DocumentationStructure;
  removed: PlanRemoval[];
}

/**
 * The planner's pages without what the owner ruled out. It runs on the model's
 * answer, before code adds pages: what it removes counts as the model's plan,
 * so a page that leaves a section empty asks the model again, and it never
 * looks like a defect of the code that adds pages.
 */
export function applyProjectInstructionsToPlan(
  structure: DocumentationStructure,
  brief: InstructionsBrief | undefined,
): DocumentationStructure {
  return filterPlanByInstructions(structure, brief).structure;
}

/** {@link applyProjectInstructionsToPlan}, with the pages that it removed and why. */
export function filterPlanByInstructions(
  structure: DocumentationStructure,
  brief: InstructionsBrief | undefined,
): FilteredPlan {
  const instructions = brief?.projectInstructions?.instructions;
  if (!instructions) return { structure, removed: [] };

  const turnedOff = new Set(turnedOffPageTypes(instructions));
  const isExcluded = excludedPathMatcher(instructions.doNotDocument);
  const landingPage = landingPageOf(structure);
  const removed: PlanRemoval[] = [];
  const keptPage = (page: DocPage): DocPage | null => {
    const reason = removalReason(page, { turnedOff, isExcluded, isLandingPage: page === landingPage });
    if (reason) {
      removed.push({ title: page.title, reason });
      return null;
    }
    return isExcluded ? withExcludedEvidenceRemoved(page, isExcluded) : page;
  };

  return {
    structure: mapSectionPages(structure, (page) => keptPage(page)),
    removed,
  };
}

/**
 * The planned pages that need a declared `pageType` and have none. With a
 * page type off, the planner declares one on each page, so a page is judged
 * by what it is, not by a word in its title. Reference pages are judged by
 * their reference, and code replaces collection item pages with its own, so
 * neither needs one.
 */
export function pagesMissingPageType(
  structure: DocumentationStructure,
  brief: InstructionsBrief | undefined,
): DocPage[] {
  const instructions = brief?.projectInstructions?.instructions;
  if (!instructions || turnedOffPageTypes(instructions).length === 0) return [];
  return structure.sections.flatMap((section) =>
    section.pages.filter((page) => !page.reference && !page.collectionItemId && !page.pageType)
  );
}

/** The retry line that asks the planner to declare the missing page types. */
export function describeMissingPageTypes(pages: readonly DocPage[]): string {
  const titles = pages.map((page) => JSON.stringify(page.title)).join(", ");
  return `Some page types are off, so every page needs a pageType. Add pageType to these pages: ${titles}.`;
}

/**
 * The structure after code added collection and reference pages, without
 * evidence under a "Do not document" path. It removes no page: the plan
 * filter already decided which pages stay, and a page that code adds must
 * stay for the checks that require it.
 */
export function withoutExcludedEvidenceInStructure(
  structure: DocumentationStructure,
  brief: InstructionsBrief | undefined,
): DocumentationStructure {
  const isExcluded = excludedPathMatcher(brief?.projectInstructions?.instructions.doNotDocument ?? []);
  if (!isExcluded) return structure;
  return mapSectionPages(structure, (page) => withExcludedEvidenceRemoved(page, isExcluded));
}

/** The line that tells the planner which pages Doxa removed, for a retry. */
export function describePlanRemovals(removed: readonly PlanRemoval[]): string | undefined {
  if (removed.length === 0) return undefined;
  return `Doxa removed these planned pages because the project instructions rule them out: ${listPlanRemovals(removed)}. ` +
    "Plan pages that the instructions allow instead.";
}

/** The removed pages with their reasons, for example `"FAQ" (the troubleshooting page type is off)`. */
export function listPlanRemovals(removed: readonly PlanRemoval[]): string {
  return removed.map(({ title, reason }) => `${JSON.stringify(title)} (${describeReason(reason)})`).join(", ");
}

function describeReason(reason: PlanRemovalReason): string {
  return reason.kind === "page_type"
    ? `the ${reason.pageType} page type is off`
    : "its evidence is only under \"Do not document\" paths";
}

interface RemovalRules {
  turnedOff: ReadonlySet<DoxabotPageType>;
  isExcluded: PathMatcher | undefined;
  /** The first page of the Documentation section: a title never removes it. */
  isLandingPage: boolean;
}

function removalReason(page: DocPage, rules: RemovalRules): PlanRemovalReason | undefined {
  const pageType = turnedOffType(page, rules);
  if (pageType) return { kind: "page_type", pageType };
  if (rules.isExcluded && hasOnlyExcludedEvidence(page, rules.isExcluded)) return { kind: "excluded_evidence" };
  return undefined;
}

/**
 * A reference page is judged by its reference alone: its title names an API
 * module, such as "Core concepts", not a page type. The landing page is judged
 * only by a declared type, so a word in its title never empties the section.
 */
function turnedOffType(page: DocPage, rules: RemovalRules): DoxabotPageType | undefined {
  if (page.reference) return rules.turnedOff.has("reference") ? "reference" : undefined;
  if (rules.isLandingPage && !page.pageType) return undefined;
  return turnedOffTypeOfPage(page, rules.turnedOff);
}

function landingPageOf(structure: DocumentationStructure): DocPage | undefined {
  const first = structure.sections[0];
  return first?.default === true || first?.title.trim() === "Documentation" ? first.pages[0] : undefined;
}

function mapSectionPages(
  structure: DocumentationStructure,
  mapPage: (page: DocPage) => DocPage | null,
): DocumentationStructure {
  return {
    sections: structure.sections.flatMap((section) => {
      const pages = section.pages.flatMap((page) => mapPage(page) ?? []);
      return pages.length > 0 ? [{ ...section, pages }] : [];
    }),
  };
}

function hasOnlyExcludedEvidence(page: DocPage, isExcluded: PathMatcher): boolean {
  const evidence = page.sourceEvidence ?? [];
  return evidence.length > 0 && evidence.every((item) => isExcluded(item.path));
}

function withExcludedEvidenceRemoved(page: DocPage, isExcluded: PathMatcher): DocPage {
  const evidence = page.sourceEvidence;
  if (!evidence?.length) return page;
  const kept = evidence.filter((item) => !isExcluded(item.path));
  return kept.length === evidence.length ? page : { ...page, sourceEvidence: kept };
}

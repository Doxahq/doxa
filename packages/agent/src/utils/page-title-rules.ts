import type { DocPage, DocumentationStructure } from "../types";

/** A title is also the sidebar label: longer titles get cut in the sidebar. */
export const MAX_PAGE_TITLE_WORDS = 5;
export const MAX_PAGE_TITLE_CHARACTERS = 36;
/** "Roles and permissions" is one subject. A longer title with "and" names two. */
const MAX_WORDS_OF_ONE_SUBJECT_WITH_AND = 3;

function wordsOf(title: string): string[] {
  return title.trim().split(/\s+/).filter(Boolean);
}

/** Collection and reference pages take their titles from the analysis, not from the planner. */
function hasPlannerTitle(page: DocPage): boolean {
  return !page.reference && !page.collectionId;
}

/** The title rule that a planned page title breaks, or null. */
export function pageTitleProblem(title: string): string | null {
  const words = wordsOf(title);
  if (words.length > MAX_PAGE_TITLE_WORDS || title.trim().length > MAX_PAGE_TITLE_CHARACTERS) {
    return `has more than ${MAX_PAGE_TITLE_WORDS} words or ${MAX_PAGE_TITLE_CHARACTERS} characters. Name the subject in 1 to 4 words, or split the page`;
  }
  if (/[,&]/.test(title)) {
    return "lists more than one subject. Split the page, one subject for each page";
  }
  const joinsSubjects = words.some((word) => word.toLowerCase() === "and");
  if (joinsSubjects && words.length > MAX_WORDS_OF_ONE_SUBJECT_WITH_AND) {
    return 'joins two subjects with "and". Split the page, or give the one subject a shorter name';
  }
  return null;
}

/**
 * The title errors of a planned structure, for the planner to correct. Only
 * the titles that the planner chose are checked.
 */
export function plannedPageTitleErrors(structure: DocumentationStructure): string[] {
  return structure.sections.flatMap((section) =>
    section.pages.filter(hasPlannerTitle).flatMap((page) => {
      const problem = pageTitleProblem(page.title);
      return problem ? [`Page title "${page.title}" ${problem}.`] : [];
    })
  );
}

import {
  PAGE_OPEN_ISSUE_LIMITS,
  type PageOpenIssue,
} from "@doxahq/contracts/generation-reviews";
import { parseFrontmatter } from "./frontmatter";
import {
  checkPageInstructionsOfPage,
  isPageInstructionCheck,
  type PageInstructionRules,
} from "./page-instruction-checks";
import { checkContentQuality, type ContentQualityIssue } from "./page-validator";

/**
 * The issues of a kept page as the review shows them: instruction breaks
 * first, at most `PAGE_OPEN_ISSUE_LIMITS.issues`, each on one bounded line.
 * The messages name a rule and at most a short excerpt of the page, which
 * passed the writer gate, so they hold nothing the page itself does not.
 */
export function pageOpenIssuesOf(issues: readonly ContentQualityIssue[]): PageOpenIssue[] {
  const openIssues = issues.flatMap((issue): PageOpenIssue[] => {
    const check = boundedLine(issue.check, PAGE_OPEN_ISSUE_LIMITS.checkLength);
    const message = boundedLine(issue.message, PAGE_OPEN_ISSUE_LIMITS.messageLength);
    if (!check || !message) return [];
    return [{ check, message, instructions: isPageInstructionCheck(issue.check) }];
  });
  return [
    ...openIssues.filter((issue) => issue.instructions),
    ...openIssues.filter((issue) => !issue.instructions),
  ].slice(0, PAGE_OPEN_ISSUE_LIMITS.issues);
}

/** One line without control characters, cut to `maxLength` with an ellipsis. */
function boundedLine(text: string, maxLength: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * The open issues of a page as it ships. The instruction breaks are found
 * again on the final text, which composing changed (sanitizing, the added
 * title heading, formatting); the other issues come from the caller. Code
 * that appends a REST reference block does so after this, so it is not
 * checked, as designed.
 */
export function openIssuesOfShippedPage(input: {
  content: string;
  rules: PageInstructionRules | undefined;
  otherIssues: readonly ContentQualityIssue[];
}): PageOpenIssue[] {
  const instructionIssues = input.rules ? checkPageInstructionsOfPage(input.content, input.rules) : [];
  return pageOpenIssuesOf([
    ...instructionIssues,
    ...input.otherIssues.filter((issue) => !isPageInstructionCheck(issue.check)),
  ]);
}

/**
 * The soft content issues of a whole page, found without an MDX compile: what
 * a section repair splice still has after the rest of the page was kept.
 */
export function softContentIssuesOfPage(content: string): ContentQualityIssue[] {
  return checkContentQuality(parseFrontmatter(content).body).issues.filter((issue) => issue.severity === "soft");
}

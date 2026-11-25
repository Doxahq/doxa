import {
  MAX_INSTRUCTION_CATCH_UP_ATTEMPTS,
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  type GenerationPageState,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import {
  GENERATION_PAGE_NOTICE_EVENT_TYPE,
  PAGE_NOTICE_LIMITS,
  UNVERIFIED_EXTERNAL_LINKS_EVENT_TYPE,
  UNVERIFIED_EXTERNAL_LINK_LIMITS,
  boundedNoticeText,
  type PageNotice,
  type UnverifiedExternalLinkPage,
  type UnverifiedExternalLinksEventData,
} from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";

/** Pages that the writer kept with issues it could not fix. */
export function openIssueNotices(pages: readonly StagedRuntimePage[]): PageNotice[] {
  return pages.flatMap((page): PageNotice[] =>
    page.openIssues?.length
      ? pageNotice({ pageId: page.id, title: page.title, route: page.route, kind: "open_issues", issues: page.openIssues })
      : []
  );
}

/**
 * The written pages that link to outside domains the repository does not
 * contain. The writer found them; the page keeps its links, because outside
 * links are allowed (owner decision, 2026-10-27).
 */
export function unverifiedExternalLinkPages(pages: readonly StagedRuntimePage[]): UnverifiedExternalLinkPage[] {
  return pages.flatMap((page): UnverifiedExternalLinkPage[] => {
    const domains = [...new Set(page.unverifiedExternalDomains ?? [])]
      .slice(0, UNVERIFIED_EXTERNAL_LINK_LIMITS.domainsPerPage);
    const [notice] = pageNotice({ pageId: page.id, title: page.title, route: page.route, kind: "open_issues", issues: [] });
    return notice && domains.length > 0
      ? [{ pageId: notice.pageId, title: notice.title, href: notice.href, domains }]
      : [];
  }).slice(0, UNVERIFIED_EXTERNAL_LINK_LIMITS.pages);
}

/** The data of the run's outside-link event, or null when no page has an unverified domain. */
export function unverifiedExternalLinksEventData(
  pages: readonly UnverifiedExternalLinkPage[],
): UnverifiedExternalLinksEventData | null {
  if (pages.length === 0) return null;
  const domains = [...new Set(pages.flatMap((page) => page.domains))]
    .slice(0, UNVERIFIED_EXTERNAL_LINK_LIMITS.domains);
  return { domains, pages: [...pages] };
}

/** The run-log line of the outside-link event. */
export function unverifiedExternalLinksMessage(data: UnverifiedExternalLinksEventData): string {
  const pageCount = data.pages.length === 1 ? "1 page links" : `${data.pages.length} pages link`;
  const domainCount = data.domains.length === 1 ? "an outside domain" : `${data.domains.length} outside domains`;
  return boundedNoticeText(
    `${pageCount} to ${domainCount} that the repository does not contain: ${data.domains.join(", ")}. ` +
      "Check the links before you publish.",
    1_000,
  );
}

/**
 * One job event for the run, so the run log lists every unverified domain
 * and its pages. Like a notice, a failed event is logged and skipped.
 */
export async function recordUnverifiedExternalLinks(input: {
  pages: readonly UnverifiedExternalLinkPage[];
  addJobEvent: (event: {
    type: string;
    message: string;
    source: "worker";
    data: UnverifiedExternalLinksEventData;
  }) => Promise<unknown>;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const data = unverifiedExternalLinksEventData(input.pages);
  if (!data) return;
  try {
    await input.addJobEvent({
      type: UNVERIFIED_EXTERNAL_LINKS_EVENT_TYPE,
      message: unverifiedExternalLinksMessage(data),
      source: "worker",
      data,
    });
  } catch (error) {
    input.onError?.(error);
  }
}

/** A page that may get a `behind_instructions` notice once the ledger says runs stopped trying it. */
export interface BehindInstructionCandidate {
  pageId: string;
  title: string;
  route: string;
}

/**
 * Pages of the current structure that are still behind the run's
 * instructions after this run: behind in the published state, not written
 * now, and not locked. A page the new plan removed has no page to check, and
 * a locked page is a person's choice, so neither is a candidate. Computed
 * where the published state is already loaded, so the notice step reads
 * nothing.
 */
export function behindInstructionCandidates(input: {
  previousPages: readonly GenerationPageState[];
  /** The fingerprint of the run that stored `previousPages`. */
  previousRunFingerprint: string | undefined;
  runFingerprint: string | undefined;
  currentPageIds: readonly string[];
  writtenPageIds: readonly string[];
  lockedHrefs: ReadonlySet<string>;
}): BehindInstructionCandidate[] {
  if (input.runFingerprint === undefined) return [];
  const current = new Set(input.currentPageIds);
  const written = new Set(input.writtenPageIds);
  const storedRunFingerprint = input.previousRunFingerprint ?? NO_PROJECT_INSTRUCTIONS_FINGERPRINT;
  return input.previousPages
    .filter((page) =>
      (page.projectInstructionsFingerprint ?? storedRunFingerprint) !== input.runFingerprint
      && current.has(page.pageId)
      && !written.has(page.pageId)
      && !input.lockedHrefs.has(normalizeHref(page.route))
    )
    .map((page) => ({ pageId: page.pageId, title: page.title, route: page.route }));
}

/**
 * The candidates that runs stopped trying after
 * `MAX_INSTRUCTION_CATCH_UP_ATTEMPTS` failed catch-ups in a row
 * (`exhaustedPageIds`, from the catch-up ledger). The review is the only
 * place that says so.
 */
export function behindInstructionsNotices(input: {
  candidates: readonly BehindInstructionCandidate[];
  exhaustedPageIds: readonly string[];
}): PageNotice[] {
  const exhausted = new Set(input.exhaustedPageIds);
  return input.candidates.flatMap((candidate): PageNotice[] =>
    exhausted.has(candidate.pageId)
      ? pageNotice({ ...candidate, kind: "behind_instructions", issues: [] })
      : []
  );
}

/**
 * One job event per notice: the run log shows it, and the review lists it.
 * A notice is extra information about pages the run already wrote, so a
 * failed event is logged and skipped, never a failed run.
 */
export async function recordPageNotices(input: {
  notices: readonly PageNotice[];
  addJobEvent: (event: {
    type: string;
    message: string;
    source: "worker";
    data: PageNotice;
  }) => Promise<unknown>;
  onError?: (notice: PageNotice, error: unknown) => void;
}): Promise<void> {
  for (const notice of input.notices) {
    try {
      await input.addJobEvent({
        type: GENERATION_PAGE_NOTICE_EVENT_TYPE,
        message: pageNoticeMessage(notice),
        source: "worker",
        data: notice,
      });
    } catch (error) {
      input.onError?.(notice, error);
    }
  }
}

/** The run-log line of a notice. Titles and issue texts are bounded when the notice is built. */
export function pageNoticeMessage(notice: PageNotice): string {
  if (notice.kind === "behind_instructions") {
    return `${notice.title} could not be updated to the current Doxabot instructions after ` +
      `${MAX_INSTRUCTION_CATCH_UP_ATTEMPTS} attempts and keeps its published version.`;
  }
  const instructionIssue = notice.issues.find((issue) => issue.instructions);
  if (instructionIssue) {
    return `${notice.title} may not follow the Doxabot instructions: ${instructionIssue.message}`;
  }
  const [firstIssue] = notice.issues;
  return firstIssue
    ? `${notice.title} was kept with an issue that the writer could not fix: ${firstIssue.message}`
    : `${notice.title} was kept with issues that the writer could not fix.`;
}

/**
 * A notice within the contract's bounds. A page ID longer than the bound is
 * not a page this pipeline writes, so it gets no notice rather than a cut one.
 */
function pageNotice(input: {
  pageId: string;
  title: string;
  route: string;
  kind: PageNotice["kind"];
  issues: PageNotice["issues"];
}): PageNotice[] {
  if (input.pageId.length === 0 || input.pageId.length > PAGE_NOTICE_LIMITS.pageIdLength) return [];
  const title = boundedNoticeText(input.title, PAGE_NOTICE_LIMITS.titleLength)
    || boundedNoticeText(input.pageId, PAGE_NOTICE_LIMITS.titleLength);
  return [{
    pageId: input.pageId,
    title,
    href: reviewHref(input.route),
    kind: input.kind,
    issues: input.issues,
  }];
}

/** The page route as a review href, or null when it is not one. */
function reviewHref(route: string): string | null {
  return route.startsWith("/") && route.length <= 512 ? route : null;
}

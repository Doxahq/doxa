import {
  GENERATION_STATE_SCHEMA_VERSION,
  MAX_INSTRUCTION_CATCH_UP_ATTEMPTS,
  type GenerationPageState,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import {
  GENERATION_PAGE_NOTICE_EVENT_TYPE,
  PAGE_NOTICE_LIMITS,
  pageNoticeSchema,
  type PageNotice,
} from "@doxahq/contracts/generation-reviews";
import { describe, expect, test } from "vitest";
import {
  behindInstructionCandidates,
  behindInstructionsNotices,
  openIssueNotices,
  pageNoticeMessage,
  recordPageNotices,
} from "../src/page-notices";

const hash = "a".repeat(64);
const dependencies = {
  sourceFilesRead: [],
  sourceFilesDiscovered: [],
  sourceEvidenceFiles: [],
  referencedSymbols: [],
  referencedRoutes: [],
};
const termIssue = { check: "instructionTerminology", message: 'Say "repository", not "repo".', instructions: true };

function runtimePage(id: string, overrides: Partial<StagedRuntimePage> = {}): StagedRuntimePage {
  return {
    id,
    title: id,
    route: `/${id}`,
    navigationPath: `default/${id}.md`,
    content: "# Page",
    dependencies,
    contentHash: hash,
    pageInputHash: hash,
    ...overrides,
  };
}

function statePage(pageId: string, overrides: Partial<GenerationPageState> = {}): GenerationPageState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId,
    title: pageId,
    route: `/${pageId}`,
    navigationPath: `default/${pageId}.md`,
    artifactKey: `sites/site-1/versions/version-1/source/${pageId}/index.mdx`,
    contentHash: hash,
    pageInputHash: hash,
    dependencies,
    ...overrides,
  };
}

describe("open issue notices", () => {
  test("lists only the written pages that carry open issues", () => {
    const notices = openIssueNotices([
      runtimePage("guide", { openIssues: [termIssue] }),
      runtimePage("clean"),
      runtimePage("empty", { openIssues: [] }),
    ]);

    expect(notices).toEqual([{
      pageId: "guide",
      title: "guide",
      href: "/guide",
      kind: "open_issues",
      issues: [termIssue],
    }]);
    expect(notices.every((notice) => pageNoticeSchema.safeParse(notice).success)).toBe(true);
  });
});

describe("behind-instructions notices", () => {
  const base = {
    previousRunFingerprint: "old",
    runFingerprint: "new" as string | undefined,
    currentPageIds: ["failing", "kept", "written", "locked"],
    writtenPageIds: [] as string[],
    exhaustedPageIds: ["failing", "removed", "locked", "written"],
    lockedHrefs: new Set<string>(),
  };
  const behind = (pageId: string) => statePage(pageId, { projectInstructionsFingerprint: "old" });
  /** Candidates come from the flagged-pages step, the ledger filter from the notice step. */
  function notices({ exhaustedPageIds, ...input }: typeof base & { previousPages: GenerationPageState[]; runFingerprint: string | undefined }) {
    return behindInstructionsNotices({ candidates: behindInstructionCandidates(input), exhaustedPageIds });
  }

  test("names a page of the current structure that ran out of catch-up attempts", () => {
    expect(notices({ ...base, previousPages: [behind("failing"), behind("kept")] })).toEqual([{
      pageId: "failing",
      title: "failing",
      href: "/failing",
      kind: "behind_instructions",
      issues: [],
    }]);
  });

  test("leaves out a page that the new plan removed", () => {
    expect(notices({ ...base, previousPages: [behind("removed")] })).toEqual([]);
  });

  test("leaves out a locked page, which a person keeps on purpose", () => {
    expect(notices({
      ...base,
      lockedHrefs: new Set(["/locked"]),
      previousPages: [behind("locked")],
    })).toEqual([]);
  });

  test("leaves out written pages, pages that follow the run, and runs without a fingerprint", () => {
    expect(notices({ ...base, writtenPageIds: ["written"], previousPages: [behind("written")] }))
      .toEqual([]);
    expect(notices({ ...base, runFingerprint: "old", previousPages: [behind("failing")] }))
      .toEqual([]);
    expect(notices({ ...base, runFingerprint: undefined, previousPages: [behind("failing")] }))
      .toEqual([]);
  });

  test("bounds a long title so the notice always passes the contract", () => {
    const [notice] = notices({
      ...base,
      previousPages: [statePage("failing", { projectInstructionsFingerprint: "old", title: `${"Long ".repeat(100)}\ntitle` })],
    });

    expect(notice?.title.length).toBeLessThanOrEqual(PAGE_NOTICE_LIMITS.titleLength);
    expect(notice?.title).not.toContain("\n");
    expect(pageNoticeSchema.safeParse(notice).success).toBe(true);
  });
});

describe("recording page notices", () => {
  test("sends one job event per notice, with a run-log line that names the issue", async () => {
    const events: { type: string; message: string; data: PageNotice }[] = [];
    const kept: PageNotice = { pageId: "guide", title: "Guide", href: "/guide", kind: "open_issues", issues: [termIssue] };
    const behind: PageNotice = { pageId: "faq", title: "FAQ", href: "/faq", kind: "behind_instructions", issues: [] };

    await recordPageNotices({
      notices: [kept, behind],
      addJobEvent: async (event) => {
        events.push(event);
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      GENERATION_PAGE_NOTICE_EVENT_TYPE,
      GENERATION_PAGE_NOTICE_EVENT_TYPE,
    ]);
    expect(events[0]?.message).toBe('Guide may not follow the Doxabot instructions: Say "repository", not "repo".');
    expect(events[1]?.message).toBe(
      `FAQ could not be updated to the current Doxabot instructions after ${MAX_INSTRUCTION_CATCH_UP_ATTEMPTS} attempts and keeps its published version.`,
    );
    expect(events.map((event) => event.data)).toEqual([kept, behind]);
  });

  test("a failed event is reported and skipped, never a failed run", async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    const notice = (pageId: string): PageNotice => ({ pageId, title: pageId, href: null, kind: "open_issues", issues: [termIssue] });

    await expect(recordPageNotices({
      notices: [notice("a"), notice("b")],
      addJobEvent: async (event) => {
        if (event.data.pageId === "a") throw new Error("API unavailable");
        sent.push(event.data.pageId);
      },
      onError: (failed) => errors.push(failed.pageId),
    })).resolves.toBeUndefined();

    expect(errors).toEqual(["a"]);
    expect(sent).toEqual(["b"]);
  });

  test("words a non-instruction issue as a writer issue", () => {
    expect(pageNoticeMessage({
      pageId: "p",
      title: "Page",
      href: null,
      kind: "open_issues",
      issues: [{ check: "cutoffContent", message: "Content appears cut off.", instructions: false }],
    })).toBe("Page was kept with an issue that the writer could not fix: Content appears cut off.");
  });
});

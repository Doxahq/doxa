import { describe, expect, test } from "vitest";
import { flaggedPagesFromEvents, pageNoticesFromEvents } from "../../src/repositories/job-events";

const flag = (pageId: string, reason: string) => ({
  pageId,
  title: pageId,
  reason,
  outcome: "left_out" as const,
  href: null,
});

describe("flagged pages from job events", () => {
  test("keeps the last flag of a page and leaves out unreadable data", () => {
    expect(flaggedPagesFromEvents([
      { data: flag("docs/a", "first") },
      { data: { pageId: "docs/b" } },
      { data: null },
      { data: flag("docs/a", "second") },
      { data: flag("docs/c", "only") },
    ])).toEqual([flag("docs/a", "second"), flag("docs/c", "only")]);
  });
});

const notice = (pageId: string, kind: "open_issues" | "behind_instructions", message = "Say \"repository\".") => ({
  pageId,
  title: pageId,
  href: `/${pageId}`,
  kind,
  issues: kind === "open_issues" ? [{ check: "instructionTerminology", message, instructions: true }] : [],
});

describe("page notices from job events", () => {
  test("keeps the last notice of each page and kind, and leaves out unreadable data", () => {
    expect(pageNoticesFromEvents([
      { data: notice("a", "open_issues", "first") },
      { data: notice("a", "behind_instructions") },
      { data: { pageId: "b", kind: "open_issues" } },
      { data: null },
      { data: notice("a", "open_issues", "second") },
    ])).toEqual([notice("a", "open_issues", "second"), notice("a", "behind_instructions")]);
  });

  test("drops keys that a newer writer adds, and refuses unbounded issue lists", () => {
    const tooMany = { ...notice("c", "open_issues"), issues: Array.from({ length: 11 }, () => notice("c", "open_issues").issues[0]) };

    expect(pageNoticesFromEvents([{ data: { ...notice("d", "open_issues"), extra: true } }, { data: tooMany }]))
      .toEqual([notice("d", "open_issues")]);
  });
});

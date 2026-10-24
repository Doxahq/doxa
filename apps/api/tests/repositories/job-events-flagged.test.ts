import { describe, expect, test } from "vitest";
import { flaggedPagesFromEvents } from "../../src/repositories/job-events";

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

import type { DocsPageMdxIssues } from "@doxahq/contracts";
import { branchIdSchema } from "@doxahq/contracts/docs-branches";
import { describe, expect, it } from "vitest";
import type { StoredBranchChange } from "../../../src/repositories/docs-branches";
import {
  branchMdxIssues,
  describeBlockedPublish,
  editMdxIssues,
  pageMdxIssues,
} from "../../../src/services/docs-content/page-mdx-issues";

const BROKEN = "# Setup\n\n<Bogus>Hi</Bogus>\n";
const VALID = "# Setup\n\n<Note>Hi</Note>\n";

function upsert(path: string, content: string): StoredBranchChange {
  return {
    branchId: branchIdSchema.parse("11111111-1111-4111-8111-111111111111"),
    path,
    byteSize: content.length,
    updatedByUserId: "user-1",
    origin: "editor",
    updatedAt: new Date(0),
    kind: "upsert",
    content,
    contentSha256: "0".repeat(64),
  };
}

function remove(path: string): StoredBranchChange {
  return {
    branchId: branchIdSchema.parse("11111111-1111-4111-8111-111111111111"),
    path,
    byteSize: 0,
    updatedByUserId: "user-1",
    origin: "editor",
    updatedAt: new Date(0),
    kind: "delete",
    content: null,
    contentSha256: null,
  };
}

function page(href: string): DocsPageMdxIssues {
  return {
    href,
    sourcePath: `source${href}/index.mdx`,
    issues: [{ line: 3, column: 1, message: "Unknown MDX component: Bogus" }],
  };
}

describe("pageMdxIssues", () => {
  it("splits the position out of the agent check", () => {
    expect(pageMdxIssues(BROKEN)).toEqual([
      { line: 3, column: 1, message: "Unknown MDX component: Bogus" },
    ]);
  });

  it("returns nothing for valid MDX", () => {
    expect(pageMdxIssues(VALID)).toEqual([]);
  });
});

describe("editMdxIssues", () => {
  it("checks only page content edits, by normalized href", () => {
    expect(
      editMdxIssues([
        { type: "set_page_content", href: "/guides/setup/", content: BROKEN },
        { type: "set_page_content", href: "/", content: VALID },
        { type: "reset_page", href: "/other" },
      ]),
    ).toEqual([
      {
        href: "/guides/setup",
        sourcePath: "source/guides/setup/index.mdx",
        issues: [expect.objectContaining({ line: 3 })],
      },
    ]);
  });
});

describe("branchMdxIssues", () => {
  it("checks changed page sources only, in path order", () => {
    const pages = branchMdxIssues([
      upsert("source/zeta/index.mdx", BROKEN),
      upsert("source/index.mdx", VALID),
      upsert("settings/documents.json", "<Bogus>"),
      remove("source/gone/index.mdx"),
      upsert("source/alpha/index.mdx", BROKEN),
    ]);

    expect(pages.map((item) => item.href)).toEqual(["/alpha", "/zeta"]);
  });
});

describe("describeBlockedPublish", () => {
  it("names one page with its first issue", () => {
    expect(describeBlockedPublish([page("/setup")])).toBe(
      "Publish blocked: 1 page has MDX issues. /setup (source/setup/index.mdx line 3): Unknown MDX component: Bogus. Fix them, then publish again.",
    );
  });

  it("names five pages, then counts the rest", () => {
    const pages = ["/a", "/b", "/c", "/d", "/e", "/f", "/g"].map(page);
    const message = describeBlockedPublish(pages);

    expect(message).toMatch(/^Publish blocked: 7 pages have MDX issues\./);
    expect(message).toContain("/e (");
    expect(message).not.toContain("/f (");
    expect(message).toContain("and 2 more.");
  });
});

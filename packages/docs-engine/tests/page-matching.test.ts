import { describe, expect, test } from "vitest";

import { matchPages, pageBody, type MatchablePage } from "../src";

function page(href: string, title: string, content: string | null, section = "default"): MatchablePage {
  return { href, title, section, content };
}

describe("page matching", () => {
  test("matches by route first, then a moved page by its body, then by its title", () => {
    const previous = [
      page("/install", "Install", "---\ntitle: Install\n---\nRun the installer."),
      page("/overview02", "Overview01", "---\ntitle: Overview01\n---\nFlagForge is a flag service."),
      page("/environments", "Environments", "Old environments text."),
      page("/gone", "Gone", "Removed text."),
    ];
    const current = [
      page("/install", "Install", "Edited installer text."),
      page("/overview", "Overview", "---\ntitle: Overview\n---\n\nFlagForge is a flag service.\n"),
      page("/projects/environments", "Environments", "New environments text."),
      page("/mine", "Mine", "A page a person wrote."),
    ];

    const matching = matchPages(previous, current);

    expect(matching.matches.map(({ previous: p, current: c, by }) => [p.href, c.href, by])).toEqual([
      ["/install", "/install", "route"],
      ["/overview02", "/overview", "body"],
      ["/environments", "/projects/environments", "title"],
    ]);
    expect(matching.unmatchedPrevious.map((p) => p.href)).toEqual(["/gone"]);
    expect(matching.unmatchedCurrent.map((p) => p.href)).toEqual(["/mine"]);
  });

  test("never pairs pages whose body or title another page shares", () => {
    const matching = matchPages(
      [page("/a", "Draft", "Same text."), page("/b", "Draft", "Same text.")],
      [page("/c", "Draft", "Same text.")],
    );

    expect(matching.matches).toEqual([]);
  });

  test("does not match empty or unreadable bodies, or the same title in another section", () => {
    const matching = matchPages(
      [page("/a", "Setup", null), page("/b", "Guide", "---\ntitle: x\n---\n")],
      [page("/c", "Setup", "x", "api"), page("/d", "Other", "")],
    );

    expect(matching.matches).toEqual([]);
  });

  test("reads a body without its frontmatter", () => {
    expect(pageBody("---\ntitle: A\n---\n\n## Body\n")).toBe("## Body");
    expect(pageBody("No frontmatter")).toBe("No frontmatter");
  });
});

import { describe, expect, test } from "vitest";

import { groupMenu } from "./sidebar-groups";

type Item =
  | { spacer: true }
  | { heading: string }
  | { title: string; href: string };
const isHeading = (item: Item): item is Item & { heading: string } =>
  "heading" in item;
const isPage = (item: Item): item is { title: string; href: string } =>
  "href" in item;

describe("groupMenu", () => {
  test("groups the pages under each heading until the next heading or spacer", () => {
    const items: Item[] = [
      { title: "Intro", href: "/" },
      { heading: "Start" },
      { title: "Install", href: "/install" },
      { title: "Configure", href: "/configure" },
      { heading: "Guides" },
      { title: "Deploy", href: "/deploy" },
      { spacer: true },
      { title: "Changelog", href: "/changelog" },
    ];
    const blocks = groupMenu(items, isHeading, isPage).map((block) =>
      block.type === "group"
        ? `${block.heading}: ${block.pages.map((page) => page.title).join(", ")}`
        : "spacer" in block.item
          ? "spacer"
          : `page ${(block.item as { title: string }).title}`
    );
    expect(blocks).toEqual([
      "page Intro",
      "Start: Install, Configure",
      "Guides: Deploy",
      "spacer",
      "page Changelog",
    ]);
  });

  test("keeps an empty heading as a group with no pages", () => {
    const blocks = groupMenu(
      [{ heading: "Empty" }, { spacer: true }] as Item[],
      isHeading,
      isPage
    );
    expect(blocks[0]).toMatchObject({
      type: "group",
      heading: "Empty",
      pages: [],
    });
  });
});

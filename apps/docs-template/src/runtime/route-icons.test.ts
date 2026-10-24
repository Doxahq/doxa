import { LUCIDE_ICON_DATA } from "@doxahq/docs-prose/icons/lucide";
import type { RuntimeMdxNode } from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import type { ParsedDocument } from "./docs-route-data";
import { collectRouteIconKeys, loadRouteIcons } from "./route-icons";
import type { RuntimeNavNode } from "./runtime-source";

function route(
  sectionNavigation: RuntimeNavNode[],
  nodes: RuntimeMdxNode[] = []
): { sectionNavigation: RuntimeNavNode[]; runtimeDocument: ParsedDocument } {
  return {
    sectionNavigation,
    runtimeDocument: { ok: true, document: { frontmatter: {}, nodes } },
  };
}

function card(icon: string): RuntimeMdxNode {
  return { type: "element", name: "Card", props: { title: "A card", icon } };
}

describe("route icons", () => {
  test("collects sidebar and card icons that the bundle lacks", () => {
    const keys = collectRouteIconKeys(
      route(
        [
          { heading: "Start" },
          {
            title: "Guide",
            href: "/guide",
            icon: "anchor",
            items: [{ title: "Nested", href: "/guide/nested", icon: "bird" }],
          },
          { title: "Home", href: "/", icon: "house" },
        ],
        [
          {
            type: "element",
            name: "CardGrid",
            children: [card("book-heart"), card("rocket"), card("anchor")],
          },
        ]
      )
    );

    // `house` and `rocket` are suggested icons, which the renderer bundles.
    expect(keys).toEqual(["anchor", "bird", "bookHeart"]);
  });

  test("a route with only suggested icons sends no glyphs", async () => {
    const icons = await loadRouteIcons(
      route([{ title: "Home", href: "/", icon: "house" }], [card("circleHelp")])
    );
    expect(icons).toBeUndefined();
  });

  test("sends the glyph of each icon by the name the route uses", async () => {
    const icons = await loadRouteIcons(
      route(
        [{ title: "Guide", href: "/guide", icon: "anchor" }],
        [card("help-circle"), card("notAnIcon"), card("<b>")]
      )
    );

    expect(icons).toEqual({
      anchor: LUCIDE_ICON_DATA.icons.anchor,
      // An old Lucide name draws the icon that replaced it.
      helpCircle: LUCIDE_ICON_DATA.icons.circleQuestionMark,
    });
  });

  test("a page that did not parse still sends its sidebar icons", async () => {
    const icons = await loadRouteIcons({
      sectionNavigation: [{ title: "Guide", href: "/guide", icon: "anchor" }],
      runtimeDocument: {
        ok: false,
        code: "MDX_RUNTIME_PARSE_FAILED",
        error: "Unexpected token",
      },
    });
    expect(Object.keys(icons ?? {})).toEqual(["anchor"]);
  });
});

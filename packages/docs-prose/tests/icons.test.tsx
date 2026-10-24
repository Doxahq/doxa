import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DOCS_ICON_NAMES } from "../src/icon-names";
import {
  CORE_ICON_CURRENT_NAMES,
  CORE_ICON_NODES,
  coreIconNode,
  DOCS_ICON_NAME_PATTERN,
  DocsIconSvg,
  docsIconKey,
  docsIconLabel,
  LUCIDE_ICON_COUNT,
  SUGGESTED_ICON_NAMES,
  type DocsIconNode,
} from "../src/icons";
import { LUCIDE_ICON_DATA, LUCIDE_ICON_NAMES, lucideIconName, lucideIconNode } from "../src/icons/lucide";
import { LUCIDE_ICON_TAGS } from "../src/icons/lucide-tags";

describe("icon names", () => {
  test.each([
    ["bookOpen", "bookOpen"],
    ["book-open", "bookOpen"],
    [" book-open ", "bookOpen"],
    ["BookOpen", "bookOpen"],
    ["book_open", "bookOpen"],
    ["arrow-down-0-1", "arrowDown01"],
    ["", null],
    ["book open!", null],
    ["<script>", null],
    [null, null],
  ])("the key for %j is %j", (name, key) => {
    expect(docsIconKey(name)).toBe(key);
  });

  test.each([
    ["bookOpen", "Book open"],
    ["zap", "Zap"],
    ["arrowDown01", "Arrow down 01"],
    ["grid2x2", "Grid 2x2"],
  ])("%s reads as %j", (name, label) => {
    expect(docsIconLabel(name)).toBe(label);
  });
});

describe("the Lucide set", () => {
  test("has every icon under a name that pages can store", () => {
    expect(LUCIDE_ICON_NAMES).toHaveLength(LUCIDE_ICON_COUNT);
    expect(LUCIDE_ICON_COUNT).toBeGreaterThan(1500);
    for (const name of LUCIDE_ICON_NAMES) expect(name).toMatch(DOCS_ICON_NAME_PATTERN);
  });

  test("every alias leads to a current icon", () => {
    for (const [alias, name] of Object.entries(LUCIDE_ICON_DATA.aliases)) {
      expect(LUCIDE_ICON_DATA.icons[alias], alias).toBeUndefined();
      expect(LUCIDE_ICON_DATA.icons[name], alias).toBeDefined();
    }
  });

  test("renamed icons keep working under their old names", () => {
    expect(lucideIconName("circleHelp")).toBe("circleQuestionMark");
    expect(lucideIconName("help-circle")).toBe("circleQuestionMark");
    expect(lucideIconName("alignJustify")).toBe("textAlignJustify");
    expect(lucideIconName("rocket")).toBe("rocket");
    expect(lucideIconName("notAnIcon")).toBeNull();
    expect(lucideIconNode("circleHelp")).toBe(LUCIDE_ICON_DATA.icons.circleQuestionMark);
  });

  test("search words are lowercase and belong to current icons", () => {
    expect(LUCIDE_ICON_TAGS.bookOpen).toContain("reading");
    for (const [name, words] of Object.entries(LUCIDE_ICON_TAGS)) {
      expect(LUCIDE_ICON_DATA.icons[name], name).toBeDefined();
      for (const word of words) expect(word).toBe(word.toLowerCase());
    }
  });
});

describe("the core set", () => {
  test("draws every suggested icon, under its stored name and its current name", () => {
    for (const name of DOCS_ICON_NAMES) {
      const current = lucideIconName(name)!;
      expect(CORE_ICON_NODES[name], name).toEqual(LUCIDE_ICON_DATA.icons[current]);
      expect(CORE_ICON_NODES[current], current).toEqual(LUCIDE_ICON_DATA.icons[current]);
    }
  });

  test("knows the current name of every suggested icon without the full set", () => {
    expect(SUGGESTED_ICON_NAMES).toEqual(DOCS_ICON_NAMES.map((name) => lucideIconName(name)));
    for (const [name, current] of Object.entries(CORE_ICON_CURRENT_NAMES)) {
      expect(lucideIconName(name), name).toBe(current);
    }
  });

  test("holds only suggested icons", () => {
    expect(coreIconNode("book-open")).toBe(CORE_ICON_NODES.bookOpen);
    expect(coreIconNode("anchor")).toBeNull();
  });
});

describe("DocsIconSvg", () => {
  test("draws an icon in the Lucide frame", () => {
    const html = renderToStaticMarkup(<DocsIconSvg node={CORE_ICON_NODES.zap} className="size-4" />);
    expect(html).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
    expect(html).toContain('class="size-4"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<path d=");
  });

  test("keeps an empty frame while an icon loads", () => {
    expect(renderToStaticMarkup(<DocsIconSvg node={null} />)).toMatch(/^<svg [^>]*><\/svg>$/);
  });

  test("draws only allowed elements and attributes", () => {
    const hostile = [
      ["script", { d: "alert(1)" }],
      ["path", { d: "M0 0h1", onload: "alert(1)", style: "x" }],
    ] as unknown as DocsIconNode;
    const html = renderToStaticMarkup(<DocsIconSvg node={hostile} />);
    expect(html).not.toContain("script");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("style");
    expect(html).toContain('<path d="M0 0h1"></path>');
  });

  test("a labelled icon is not hidden from screen readers", () => {
    const html = renderToStaticMarkup(<DocsIconSvg node={CORE_ICON_NODES.zap} aria-label="Fast" />);
    expect(html).toContain('aria-label="Fast"');
    expect(html).not.toContain("aria-hidden");
  });
});

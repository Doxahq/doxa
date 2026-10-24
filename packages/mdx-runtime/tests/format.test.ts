import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

import { parseRuntimeMdx } from "../src";
import { formatMdx } from "../src/format";

// The frozen artifact sets hold real generated pages. They are read here and
// never written.
const SETS_DIRECTORY = join(import.meta.dirname, "../../docs-artifact-fixtures/sets");

function listMdxFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return listMdxFiles(path);
    return name.endsWith(".mdx") ? [path] : [];
  });
}

const fixturePages = listMdxFiles(SETS_DIRECTORY).map((path) => ({
  name: relative(SETS_DIRECTORY, path),
  source: readFileSync(path, "utf8"),
}));

describe("formatMdx on fixture pages", () => {
  test("finds the fixture pages", () => {
    expect(fixturePages.length).toBeGreaterThan(10);
  });

  test.each(fixturePages)("$name renders the same after formatting", ({ source }) => {
    expect(parseRuntimeMdx(formatMdx(source))).toEqual(parseRuntimeMdx(source));
  });

  test.each(fixturePages)("$name is stable when formatted twice", ({ source }) => {
    const once = formatMdx(source);
    expect(formatMdx(once)).toBe(once);
  });
});

describe("formatMdx with escaped ESM keywords", () => {
  test("keeps the escape of a paragraph line that starts with import or export", () => {
    const source = "Intro.\n\n&#101;xport const leaked = 1\n\nText\n&#105;mport fs from 'node:fs'\n";

    const formatted = formatMdx(source);

    expect(formatted).not.toMatch(/^(?:import|export)\b/m);
    expect(parseRuntimeMdx(formatted)).toEqual(parseRuntimeMdx(source));
  });
});

describe("formatMdx style", () => {
  test("writes the shared Markdown style", () => {
    const source = [
      "Setup",
      "=====",
      "",
      "* one",
      "* two",
      "",
      "1) first",
      "2) second",
      "",
      "Some __bold__ and *italic* text.",
      "",
      "~~~ts",
      "const a = 1",
      "~~~",
      "",
      "***",
      "",
    ].join("\n");

    expect(formatMdx(source)).toBe(
      [
        "# Setup",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "Some **bold** and _italic_ text.",
        "",
        "```ts",
        "const a = 1",
        "```",
        "",
        "---",
        "",
      ].join("\n"),
    );
  });

  test("keeps the frontmatter text exactly", () => {
    const frontmatter = "---\ntitle: 'Quick start'\nkeywords:\n  - a\n  - b\n---\n";
    const formatted = formatMdx(`${frontmatter}* item\n`);
    expect(formatted).toBe(`${frontmatter}- item\n`);
  });

  test("uses double quotes in component attributes", () => {
    expect(formatMdx("<Card title='Quickstart' href=\"/quickstart\" />\n")).toBe(
      "<Card title=\"Quickstart\" href=\"/quickstart\" />\n",
    );
  });

  test("keeps a block with a JavaScript expression byte for byte", () => {
    const mermaid = "<Mermaid\n  chart={`graph TD;\n    A --> B;`}\n/>";
    const formatted = formatMdx(`* item\n\n${mermaid}\n`);
    expect(formatted).toBe(`- item\n\n${mermaid}\n`);
  });

  test("returns a body that does not parse unchanged", () => {
    const broken = "---\ntitle: Broken\n---\n<Note>\nNever closed\n";
    expect(formatMdx(broken)).toBe(broken);
  });

  test("keeps an empty body empty", () => {
    expect(formatMdx("---\ntitle: Empty\n---\n")).toBe("---\ntitle: Empty\n---\n");
  });
});

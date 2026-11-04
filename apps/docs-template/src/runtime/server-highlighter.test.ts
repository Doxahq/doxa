import { readFileSync } from "node:fs";

import { listFrozenArtifactSets } from "@doxahq/docs-artifact-fixtures";
import { parseRuntimeMdx } from "@doxahq/mdx-runtime";
import { getDocsHighlighter } from "@doxahq/mdx-runtime/highlight";
import {
  createLazyDocsHighlighter,
  type LazyDocsHighlighter,
} from "@doxahq/mdx-runtime/highlight-lazy";
import { afterEach, describe, expect, test } from "vitest";

import {
  parseDocsRouteDocument,
  type DocsParserHighlighter,
} from "./docs-route-data";
import type { RuntimeRouteData } from "./runtime-source";
import { createPageHighlighting } from "./server-highlighter";

const PAGE = [
  "# Install",
  "",
  "```bash",
  "npm install @acme/widget",
  "```",
  "",
  '<Tabs defaultValue="ts">',
  '  <TabsContent value="ts">',
  '    ```ts title="widget.ts"',
  '    import { widget } from "@acme/widget";',
  "    const ready: boolean = widget.start();",
  "    ```",
  "  </TabsContent>",
  "</Tabs>",
  "",
  "> ```json",
  '> { "ok": true }',
  "> ```",
  "",
  "```md",
  "Run `npx widget` first.",
  "",
  "```yaml",
  "name: widget",
  "```",
].join("\n");

const created: LazyDocsHighlighter[] = [];

async function fresh(): Promise<LazyDocsHighlighter> {
  const lazy = await createLazyDocsHighlighter();
  created.push(lazy);
  return lazy;
}

afterEach(() => {
  for (const lazy of created.splice(0)) lazy.shiki.dispose();
});

function parseWith(highlighter: DocsParserHighlighter) {
  return parseRuntimeMdx(PAGE, { sourceLabel: "/install", highlighter });
}

describe("createPageHighlighting", () => {
  test("gives the same document as the highlighter with every grammar", async () => {
    const highlighting = createPageHighlighting(await fresh());

    const document = await highlighting.parse(PAGE, parseWith);

    expect(document).toEqual(parseWith(getDocsHighlighter()));
  });

  test("loads only the grammars the page uses", async () => {
    const lazy = await fresh();
    const page = "```bash\nnpm test\n```\n\n```ts\nconst a = 1;\n```";

    await createPageHighlighting(lazy).parse(page, (highlighter) =>
      parseRuntimeMdx(page, { highlighter })
    );

    expect(lazy.isReady("bash")).toBe(true);
    expect(lazy.isReady("typescript")).toBe(true);
    expect(lazy.isReady("json")).toBe(false);
    expect(lazy.isReady("python")).toBe(false);
  });

  test("parses again when the scan misses a fence the parser highlights", async () => {
    const lazy = await fresh();
    const highlighting = createPageHighlighting(lazy, () => []);
    let parses = 0;

    const document = await highlighting.parse(PAGE, (highlighter) => {
      parses += 1;
      return parseWith(highlighter);
    });

    expect(parses).toBe(2);
    expect(document).toEqual(parseWith(getDocsHighlighter()));
  });

  test("parses once when the page has no highlighted fence", async () => {
    const highlighting = createPageHighlighting(await fresh());
    let parses = 0;

    await highlighting.parse("# Plain\n\nNo code here.", (highlighter) => {
      parses += 1;
      return parseRuntimeMdx("# Plain\n\nNo code here.", { highlighter });
    });

    expect(parses).toBe(1);
  });
});

describe("server highlighting on published pages", () => {
  const pages = listFrozenArtifactSets().flatMap((set) =>
    set.manifest.pages.map((page) => ({
      name: `${set.name} ${page.href}`,
      path: set.expectedRouteDataPath(page.href),
    }))
  );

  test.each(pages)(
    "$name matches the highlighter with every grammar",
    async ({ path }) => {
      const golden = JSON.parse(readFileSync(path, "utf8")) as {
        ok: boolean;
        data: RuntimeRouteData;
      };
      if (golden.data.type !== "page" || !golden.data.page) return;
      const { body, href } = golden.data.page;

      const document = await createPageHighlighting(await fresh()).parse(
        body,
        (highlighter) => parseDocsRouteDocument(body, href, highlighter)
      );

      expect(document).toEqual(
        parseDocsRouteDocument(body, href, getDocsHighlighter())
      );
    }
  );
});

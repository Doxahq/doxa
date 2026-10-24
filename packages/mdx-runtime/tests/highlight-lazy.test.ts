import type { LanguageRegistration } from "shiki/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { collectFenceLanguages, parseRuntimeMdx } from "../src";
import { getDocsCodeBlockTransformers } from "../src/highlight/code-block-transformer";
import { FENCE_LANGUAGES } from "../src/highlight/fence-languages";
import { DOCS_LANGUAGES } from "../src/highlight/grammars";
import { getDocsHighlighter } from "../src/highlight/highlighter";
import {
  createLazyDocsHighlighter,
  DOCS_GRAMMAR_COMPANIONS,
  DOCS_GRAMMAR_LOADERS,
  getLazyDocsHighlighter,
  type DocsGrammarName,
  type LazyDocsHighlighter,
} from "../src/highlight/lazy";

const created: LazyDocsHighlighter[] = [];

/** A new highlighter, released after the test so Shiki does not warn about instances. */
async function fresh(): Promise<LazyDocsHighlighter> {
  const lazy = await createLazyDocsHighlighter();
  created.push(lazy);
  return lazy;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const lazy of created.splice(0)) lazy.shiki.dispose();
});

/** One sample per grammar, written to reach the grammar's main rules. */
const SAMPLES: Record<DocsGrammarName | "text", string> = {
  bash: [
    "#!/usr/bin/env bash",
    'export TOKEN="$(cat ~/.doxa/token)"',
    'for file in docs/*.mdx; do echo "${file%.mdx}" | tr a-z A-Z; done',
    "npx doxa deploy --prod 2>&1 | tee deploy.log",
  ].join("\n"),
  json: '{\n  "name": "doxa",\n  "private": true,\n  "version": 2,\n  "tags": ["docs", null, 1.5e3]\n}',
  typescript: [
    'import { readFile } from "node:fs/promises";',
    "",
    "export interface Page<T = unknown> { href: string; data?: T }",
    "",
    "export async function load(href: string): Promise<Page> {",
    "  const text = await readFile(`./${href}.mdx`, \"utf8\"); // read it",
    "  return { href, data: JSON.parse(text) as unknown };",
    "}",
  ].join("\n"),
  tsx: [
    'import { useState } from "react";',
    "export function Counter({ start }: { start: number }) {",
    "  const [count, setCount] = useState<number>(start);",
    '  return <button className="btn" onClick={() => setCount(count + 1)}>{count}</button>;',
    "}",
  ].join("\n"),
  jsx: [
    "export default function Card({ title, children }) {",
    '  return <section aria-label={title}><h2>{title}</h2>{children}</section>;',
    "}",
  ].join("\n"),
  css: ":root { --accent: #3b82f6; }\n.card > a:hover::after {\n  content: \"→\";\n  color: var(--accent);\n  transition: opacity 120ms ease-in;\n}\n@media (min-width: 640px) { .card { padding: 2rem; } }",
  markdown: [
    "# Install",
    "",
    "Run **this** with `npx` and see [the guide](/guide).",
    "",
    "```ts",
    "const ready: boolean = true;",
    "```",
    "",
    "```json",
    '{ "ok": true }',
    "```",
    "",
    "```bash",
    "npm install doxa",
    "```",
    "",
    "<div class=\"note\">HTML in Markdown</div>",
    "",
    "- one",
    "- two",
  ].join("\n"),
  yaml: "name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest # runner\n    steps:\n      - uses: actions/checkout@v4\n      - run: |\n          pnpm install\n          pnpm build",
  python: [
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    "class Page:",
    "    href: str",
    "    views: int = 0",
    "",
    "    def title(self) -> str:",
    '        return f"{self.href!r} ({self.views})"  # format',
  ].join("\n"),
  go: [
    "package main",
    "",
    'import "fmt"',
    "",
    "type Page struct { Href string `json:\"href\"` }",
    "",
    "func main() {",
    '\tpages := []Page{{Href: "/"}}',
    "\tfor _, p := range pages { fmt.Println(p.Href) }",
    "}",
  ].join("\n"),
  html: [
    "<!doctype html>",
    '<html lang="en">',
    "  <head><style>body { margin: 0; }</style></head>",
    '  <body class="docs">',
    "    <!-- comment -->",
    '    <script type="module">const el = document.querySelector("body"); el.dataset.ready = "1";</script>',
    "  </body>",
    "</html>",
  ].join("\n"),
  sql: "SELECT p.href, COUNT(*) AS views\nFROM pages p\nLEFT JOIN visits v ON v.page_id = p.id\nWHERE p.published = TRUE AND p.created_at > '2026-01-01'\nGROUP BY p.href\nORDER BY views DESC\nLIMIT 10; -- top pages",
  rust: [
    "use std::collections::HashMap;",
    "",
    "#[derive(Debug, Clone)]",
    "pub struct Page<'a> { href: &'a str }",
    "",
    "fn main() {",
    "    let mut views: HashMap<&str, u32> = HashMap::new();",
    '    *views.entry("/").or_insert(0) += 1;',
    '    println!("{:?}", views);',
    "}",
  ].join("\n"),
  java: [
    "package so.doxa;",
    "",
    "import java.util.List;",
    "",
    "public final class Pages {",
    "  @Override public String toString() { return \"Pages\"; }",
    "  public static void main(String[] args) {",
    '    List<String> hrefs = List.of("/", "/guide");',
    "    hrefs.forEach(System.out::println);",
    "  }",
    "}",
  ].join("\n"),
  diff: "diff --git a/docs/index.mdx b/docs/index.mdx\n--- a/docs/index.mdx\n+++ b/docs/index.mdx\n@@ -1,3 +1,3 @@\n # Welcome\n-Old line\n+New line\n context",
  http: [
    "POST /v1/pages HTTP/1.1",
    "Host: api.doxa.so",
    "Content-Type: application/json",
    "Authorization: Bearer token",
    "",
    '{ "href": "/guide", "draft": false }',
  ].join("\n"),
  dockerfile: [
    "FROM node:24-alpine AS build",
    "WORKDIR /app",
    "COPY package.json pnpm-lock.yaml ./",
    'RUN corepack enable && pnpm install --frozen-lockfile',
    "ENV NODE_ENV=production",
    'CMD ["node", "server.js"]',
  ].join("\n"),
  toml: '[package]\nname = "doxa"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] } # serde\n\n[[bin]]\nname = "cli"\nenabled = true\ncount = 3',
  graphql: [
    "query Page($href: String!) {",
    "  page(href: $href) {",
    "    title",
    "    ... on Guide { steps @include(if: true) }",
    "  }",
    "}",
  ].join("\n"),
  xml: '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <!-- pages -->\n  <url><loc>https://doxa.page/</loc><priority>1.0</priority></url>\n  <![CDATA[ raw ]]>\n</urlset>',
  scss: "$accent: #3b82f6;\n@mixin card($pad: 1rem) { padding: $pad; }\n.card {\n  @include card(2rem);\n  &:hover { color: darken($accent, 10%); }\n  .title { font-weight: 600; }\n}",
  text: "Plain text keeps its theme color.\nSecond line.",
};

const CODE_TO_HAST_OPTIONS = {
  themes: { light: "github-light", dark: "github-dark" },
  defaultColor: false,
  meta: { __raw: "{1-2} showLineNumbers" },
} as const;

const CODE_TO_TOKENS_OPTIONS = {
  themes: { light: "github-light", dark: "github-dark" },
  defaultColor: false,
} as const;

/** Every fence alias with the grammar it resolves to, and the sample for that grammar. */
const FENCE_CASES = [...FENCE_LANGUAGES].map(
  ([fence, grammar]) => [fence, grammar, SAMPLES[grammar as DocsGrammarName | "text"]] as const,
);

describe("lazy documentation highlighting", () => {
  test("has a loader for every grammar the sync highlighter supports", () => {
    const grammars = new Set(FENCE_LANGUAGES.values());
    grammars.delete("text");
    expect(new Set(Object.keys(DOCS_GRAMMAR_LOADERS))).toEqual(grammars);
    expect(Object.keys(SAMPLES).sort()).toEqual([...grammars, "text"].sort());
  });

  test("its loaders bring the same grammars as the sync highlighter", async () => {
    const lazyScopes = new Set<string>();
    for (const load of Object.values(DOCS_GRAMMAR_LOADERS)) {
      for (const registration of (await load()).default) lazyScopes.add(registration.scopeName);
    }
    const syncScopes = new Set(
      DOCS_LANGUAGES.flat().map((registration) => registration.scopeName),
    );
    expect(lazyScopes).toEqual(syncScopes);
  });

  // A grammar can include another grammar's scope. The sync highlighter has
  // every grammar, so such an include always resolves there. The lazy one must
  // load the same grammars first, or a block would be colored differently.
  test("loads every grammar that a grammar includes from the full set", async () => {
    const allScopes = new Set(
      DOCS_LANGUAGES.flat().map((registration) => registration.scopeName),
    );
    for (const [name, load] of Object.entries(DOCS_GRAMMAR_LOADERS)) {
      const grammar = name as DocsGrammarName;
      const available = new Set<string>();
      for (const member of [grammar, ...(DOCS_GRAMMAR_COMPANIONS[grammar] ?? [])]) {
        for (const registration of (await DOCS_GRAMMAR_LOADERS[member]()).default) {
          available.add(registration.scopeName);
        }
      }
      const included = new Set<string>();
      for (const registration of (await load()).default) collectIncludes(registration, included);
      const missing = [...included].filter((scope) => allScopes.has(scope) && !available.has(scope));
      expect(missing, grammar).toEqual([]);
    }
  });

  test.each(FENCE_CASES)(
    "colors the %s fence exactly as the sync highlighter does",
    async (fence, grammar, sample) => {
      const lazy = await fresh();
      await lazy.load([fence]);
      expect(lazy.isReady(fence)).toBe(true);

      const sync = getDocsHighlighter();
      const hastOptions = {
        ...CODE_TO_HAST_OPTIONS,
        lang: grammar,
        transformers: getDocsCodeBlockTransformers(),
      };
      // The site parser's call.
      expect(lazy.shiki.codeToHast(sample, hastOptions)).toEqual(sync.codeToHast(sample, hastOptions));
      // The Write editor's call.
      expect(lazy.shiki.codeToTokens(sample, { ...CODE_TO_TOKENS_OPTIONS, lang: grammar })).toEqual(
        sync.codeToTokens(sample, { ...CODE_TO_TOKENS_OPTIONS, lang: grammar }),
      );
      // The whole parse, as the preview runs it.
      const page = `# Code\n\n\`\`\`${fence} {1}\n${sample}\n\`\`\`\n`;
      expect(parseRuntimeMdx(page, { highlighter: lazy.parserHighlighter })).toEqual(
        parseRuntimeMdx(page, { highlighter: sync }),
      );
    },
  );

  test("loads only the grammars it is asked for", async () => {
    const lazy = await fresh();
    await lazy.load(["sh", "json"]);

    expect(lazy.isReady("bash")).toBe(true);
    expect(lazy.isReady("zsh")).toBe(true);
    expect(lazy.isReady("json")).toBe(true);
    expect(lazy.isReady("typescript")).toBe(false);
    expect(lazy.isReady("python")).toBe(false);
    expect(lazy.shiki.getLoadedLanguages()).not.toContain("python");
    expect(lazy.shiki.getLoadedLanguages()).not.toContain("typescript");
  });

  test("treats plain text as ready and skips unknown names", async () => {
    const lazy = await fresh();
    await lazy.load(["not-a-language", ""]);

    expect(lazy.isReady("text")).toBe(true);
    expect(lazy.isReady("plaintext")).toBe(true);
    expect(lazy.isReady("not-a-language")).toBe(false);
    expect(lazy.shiki.getLoadedLanguages()).toEqual([]);
  });

  test("draws a fence plain, without a warning, until its grammar is ready", async () => {
    const lazy = await fresh();
    const warn = vi.spyOn(console, "warn");
    const page = "```python\nprint('hi')\n```\n\n```json\n{}\n```\n";
    await lazy.load(["json"]);

    const parsed = parseRuntimeMdx(page, { highlighter: lazy.parserHighlighter });
    const plain = parseRuntimeMdx(page);
    const sync = parseRuntimeMdx(page, { highlighter: getDocsHighlighter() });

    expect(parsed.nodes[0]).toEqual(plain.nodes[0]);
    expect(parsed.nodes[1]).toEqual(sync.nodes[1]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps Markdown waiting until the grammars it embeds are loaded", async () => {
    const lazy = await fresh();
    await lazy.load(["md"]);

    expect(lazy.isReady("markdown")).toBe(true);
    for (const companion of DOCS_GRAMMAR_COMPANIONS.markdown ?? []) {
      expect(lazy.isReady(companion), companion).toBe(true);
    }
  });

  test("loads each grammar once when asked again", async () => {
    const lazy = await fresh();
    const load = vi.spyOn(DOCS_GRAMMAR_LOADERS, "json");
    await Promise.all([lazy.load(["json"]), lazy.load(["jsonc", "json5"])]);
    await lazy.load(["json"]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  test("tries a grammar again after a failed download", async () => {
    const lazy = await fresh();
    vi.spyOn(DOCS_GRAMMAR_LOADERS, "toml").mockRejectedValueOnce(new Error("offline"));

    await expect(lazy.load(["toml"])).resolves.toBeUndefined();
    expect(lazy.isReady("toml")).toBe(false);

    await lazy.load(["toml"]);
    expect(lazy.isReady("toml")).toBe(true);
  });

  test("shares one instance across the page", async () => {
    expect(await getLazyDocsHighlighter()).toBe(await getLazyDocsHighlighter());
  });
});

describe("page fence languages", () => {
  test("collects each fence language once, by grammar name, in order", () => {
    const source = [
      "---",
      "title: Install",
      "---",
      "",
      "```sh",
      "npm i doxa",
      "```",
      "",
      "~~~ts title=\"a.ts\"",
      "const a = 1",
      "~~~",
      "",
      "```bash {2}",
      "echo again",
      "```",
      "",
      "```",
      "no language",
      "```",
      "",
      "```not-a-language",
      "x",
      "```",
    ].join("\n");

    expect(collectFenceLanguages(source)).toEqual(["bash", "typescript"]);
  });

  test("finds fences inside components, lists and quotes", () => {
    const source = [
      "<Tabs>",
      '  <Tab title="Python">',
      "    ```py",
      "    print(1)",
      "    ```",
      "  </Tab>",
      "</Tabs>",
      "",
      "- ```json",
      "  {}",
      "  ```",
      "",
      "1. ```yaml",
      "   a: 1",
      "   ```",
      "",
      "> ```go",
      "> package main",
      "> ```",
    ].join("\n");

    expect(collectFenceLanguages(source)).toEqual(["python", "json", "yaml", "go"]);
  });

  test("ignores inline code and text that is not a fence opener", () => {
    expect(collectFenceLanguages("Use `ts` here, and ``rust`` there.\n\n``` \n```\n")).toEqual([]);
  });
});

function collectIncludes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIncludes(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as LanguageRegistration)) {
    if (key === "include" && typeof child === "string") {
      if (!child.startsWith("#") && child !== "$self" && child !== "$base") {
        out.add(child.split("#")[0] ?? child);
      }
      continue;
    }
    collectIncludes(child, out);
  }
}

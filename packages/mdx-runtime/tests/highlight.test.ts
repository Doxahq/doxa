import type { HighlighterCore } from "shiki/core";
import { describe, expect, test, vi } from "vitest";

import { createRuntimeMdxCodeBlock, parseRuntimeMdx } from "../src";
import { getDocsCodeBlockTransformers } from "../src/highlight/code-block-transformer";
import {
  FENCE_LANGUAGES,
  resolveFenceLanguage,
} from "../src/highlight/fence-languages";
import { DOCS_LANGUAGES, DOCS_THEMES } from "../src/highlight/grammars";
import { hastToRuntimeMdx } from "../src/highlight/hast-to-runtime";
import { getDocsHighlighter } from "../src/highlight/highlighter";

describe("documentation syntax highlighting", () => {
  test("creates a highlighted runtime code block without parsing MDX", () => {
    const source = '{\n  "status": "ready"\n}';
    const node = createRuntimeMdxCodeBlock(source, {
      language: "json",
      highlighter: getDocsHighlighter(),
    });

    expect(node).toMatchObject({
      type: "element",
      name: "pre",
      props: {
        className: expect.stringContaining("shiki"),
        raw: source,
        "data-language": "json",
      },
    });
    expect(readRuntimeText(node)).toBe(source);
  });

  test("loads only the supported languages and themes", () => {
    expect(DOCS_LANGUAGES).toHaveLength(21);
    expect(DOCS_THEMES).toHaveLength(2);
  });

  test.each([
    ["md", "markdown"],
    ["mdx", "markdown"],
    ["ts", "typescript"],
    ["js", "typescript"],
    ["javascript", "typescript"],
    ["mjs", "typescript"],
    ["cjs", "typescript"],
    ["sh", "bash"],
    ["shell", "bash"],
    ["zsh", "bash"],
    ["console", "bash"],
    ["shellscript", "bash"],
    ["BASH", "bash"],
    ["jsonc", "json"],
    ["json5", "json"],
    ["py", "python"],
    ["golang", "go"],
    ["rs", "rust"],
    ["htm", "html"],
    ["gql", "graphql"],
    ["docker", "dockerfile"],
    ["text", "text"],
    ["graphql", "graphql"],
    ["", null],
  ])("resolves the %s fence alias", (input, expected) => {
    expect(resolveFenceLanguage(input)).toBe(expected);
  });

  test("highlights every registered grammar fence", () => {
    for (const [fence, grammar] of FENCE_LANGUAGES) {
      if (grammar === "text") continue;

      const node = createRuntimeMdxCodeBlock("example", {
        language: fence,
        highlighter: getDocsHighlighter(),
      });

      expect(JSON.stringify(node), fence).toContain("--shiki-light");
    }
  });

  test("reuses one highlighter instance", () => {
    expect(getDocsHighlighter()).toBe(getDocsHighlighter());
  });

  test("preserves the raw code on the generated pre node", () => {
    const source = 'const message = "copy me";';
    const tree = getDocsHighlighter().codeToHast(source, {
      lang: "typescript",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      transformers: getDocsCodeBlockTransformers(),
    });

    expect(tree.children[0]).toMatchObject({
      type: "element",
      tagName: "pre",
      properties: { raw: source },
    });
  });

  test("converts array classes and style strings to React props", () => {
    expect(
      hastToRuntimeMdx({
        type: "element",
        tagName: "pre",
        properties: {
          class: ["shiki", "github-light", false],
          style: "background-color:#fff;color:var(--shiki-light);--x: red",
          tabindex: 0,
        },
        children: [],
      }),
    ).toEqual({
      type: "element",
      name: "pre",
      props: {
        className: "shiki github-light",
        style: {
          backgroundColor: "#fff",
          color: "var(--shiki-light)",
          "--x": "red",
        },
        tabIndex: 0,
      },
    });
  });

  test("converts string classes", () => {
    expect(
      hastToRuntimeMdx({
        type: "element",
        tagName: "span",
        properties: { class: "line" },
        children: [],
      }),
    ).toMatchObject({ props: { className: "line" } });
  });

  test("converts text nodes", () => {
    expect(hastToRuntimeMdx({ type: "text", value: "const" })).toEqual({
      type: "text",
      value: "const",
    });
  });

  test("rejects unsupported highlighted elements", () => {
    expect(() =>
      hastToRuntimeMdx({
        type: "element",
        tagName: "div",
        children: [],
      }),
    ).toThrow("Unsupported highlighted element: div");
  });

  test("contains a highlighter exception to its code block", () => {
    const source = "const stable = true;";
    const highlighter = {
      codeToHast: () => {
        throw new Error("transformer crashed");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const document = parseRuntimeMdx(`\`\`\`ts\n${source}\n\`\`\``, {
        highlighter,
      });

      expect(document.nodes).toEqual([
        {
          type: "element",
          name: "pre",
          props: { raw: source, "data-language": "ts" },
          children: [
            {
              type: "element",
              name: "code",
              props: { className: "language-ts" },
              children: [{ type: "text", value: source }],
            },
          ],
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        "[mdx-runtime] Syntax highlighting fallback:",
        expect.objectContaining({ message: "transformer crashed" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("contains unsupported highlighted elements to their code block", () => {
    const source = "const stable = true;";
    const invalidHighlightedTree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "pre",
          properties: { class: "shiki" },
          children: [
            {
              type: "element",
              tagName: "code",
              properties: {},
              children: [
                {
                  type: "element",
                  tagName: "div",
                  properties: {},
                  children: [{ type: "text", value: source }],
                },
              ],
            },
          ],
        },
      ],
    } satisfies ReturnType<HighlighterCore["codeToHast"]>;
    const highlighter = {
      codeToHast: () => invalidHighlightedTree,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const document = parseRuntimeMdx(`\`\`\`ts\n${source}\n\`\`\``, {
        highlighter,
      });

      expect(document.nodes).toEqual([
        {
          type: "element",
          name: "pre",
          props: { raw: source, "data-language": "ts" },
          children: [
            {
              type: "element",
              name: "code",
              props: { className: "language-ts" },
              children: [{ type: "text", value: source }],
            },
          ],
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        "[mdx-runtime] Syntax highlighting fallback:",
        expect.objectContaining({
          message: "Unsupported highlighted element: div",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

function readRuntimeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ("type" in node && node.type === "text" && "value" in node) {
    return typeof node.value === "string" ? node.value : "";
  }
  if (!("children" in node) || !Array.isArray(node.children)) return "";
  return node.children.map(readRuntimeText).join("");
}

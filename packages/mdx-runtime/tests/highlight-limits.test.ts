import { describe, expect, test, vi } from "vitest";

import { parseRuntimeMdx, type RuntimeMdxNode } from "../src";
import { getDocsHighlighter } from "../src/highlight/highlighter";
import {
  MAX_HIGHLIGHTED_CHARS_PER_PAGE,
  MAX_HIGHLIGHTED_CODE_BLOCK_CHARS,
  MAX_TOKENIZED_LINE_LENGTH,
} from "../src/parser";

function fence(language: string, code: string): string {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

function countElements(nodes: readonly RuntimeMdxNode[], name: string): number {
  return nodes.reduce(
    (count, node) =>
      node.type === "element"
        ? count +
          (node.name === name ? 1 : 0) +
          countElements(node.children ?? [], name)
        : count,
    0,
  );
}

describe("highlighting limits (M46: one isolate, many sites)", () => {
  test("passes the line-length limit to Shiki", () => {
    const codeToHast = vi.fn(() => ({ type: "root" as const, children: [] }));
    parseRuntimeMdx(fence("ts", "const a = 1;"), {
      highlighter: { codeToHast },
    });
    expect(codeToHast).toHaveBeenCalledWith(
      "const a = 1;",
      expect.objectContaining({
        tokenizeMaxLineLength: MAX_TOKENIZED_LINE_LENGTH,
      }),
    );
  });

  test("draws a block above the size cap as plain text without tokenizing it", () => {
    const codeToHast = vi.fn();
    const code = "x".repeat(MAX_HIGHLIGHTED_CODE_BLOCK_CHARS + 1);
    const document = parseRuntimeMdx(fence("ts", code), {
      highlighter: { codeToHast },
    });

    expect(codeToHast).not.toHaveBeenCalled();
    expect(document.nodes).toEqual([
      {
        type: "element",
        name: "pre",
        props: { raw: code, "data-language": "ts" },
        children: [
          {
            type: "element",
            name: "code",
            props: { className: "language-ts" },
            children: [{ type: "text", value: code }],
          },
        ],
      },
    ]);
  });

  test("highlights a block at the size cap", () => {
    const line = "const value = 1;\n";
    const code = line
      .repeat(Math.floor(MAX_HIGHLIGHTED_CODE_BLOCK_CHARS / line.length))
      .trimEnd();
    expect(code.length).toBeLessThanOrEqual(MAX_HIGHLIGHTED_CODE_BLOCK_CHARS);
    const document = parseRuntimeMdx(fence("ts", code), {
      highlighter: getDocsHighlighter(),
    });
    expect(countElements(document.nodes, "span")).toBeGreaterThan(0);
  });

  test("draws the blocks after the page budget plain", () => {
    const codeToHast = vi.fn(() => ({ type: "root" as const, children: [] }));
    const block = "y".repeat(MAX_HIGHLIGHTED_CODE_BLOCK_CHARS);
    const blocks = Math.floor(
      MAX_HIGHLIGHTED_CHARS_PER_PAGE / MAX_HIGHLIGHTED_CODE_BLOCK_CHARS,
    );
    const source = Array.from({ length: blocks + 2 }, () =>
      fence("ts", block),
    ).join("\n\n");

    parseRuntimeMdx(source, { highlighter: { codeToHast } });
    expect(codeToHast).toHaveBeenCalledTimes(blocks);

    // The budget is per page: the next page starts again.
    parseRuntimeMdx(fence("ts", block), { highlighter: { codeToHast } });
    expect(codeToHast).toHaveBeenCalledTimes(blocks + 1);
  });

  test("keeps a normal block's output unchanged by the line limit", () => {
    const highlighter = getDocsHighlighter();
    const source = fence("ts", 'export const greeting = "hello";');
    const limited = parseRuntimeMdx(source, { highlighter });
    const unlimited = parseRuntimeMdx(source, {
      highlighter: {
        codeToHast: (code, options) =>
          highlighter.codeToHast(code, {
            ...options,
            tokenizeMaxLineLength: 0,
          }),
      },
    });
    expect(limited).toEqual(unlimited);
  });

  test("does not tokenize a line above the limit", () => {
    const longLine = `const data = "${"a".repeat(MAX_TOKENIZED_LINE_LENGTH)}";`;
    const document = parseRuntimeMdx(fence("ts", longLine), {
      highlighter: getDocsHighlighter(),
    });
    // Shiki draws the over-long line as one plain token.
    expect(countElements(document.nodes, "span")).toBeLessThanOrEqual(2);
  });
});

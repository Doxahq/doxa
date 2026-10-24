import { describe, expect, test } from "vitest";

import {
  isRuntimeMdxComponentName,
  parseRuntimeMdx,
  readFrontmatter,
  RUNTIME_MDX_COMPONENT_NAMES,
  type RuntimeMdxElementNode,
  type RuntimeMdxNode,
} from "../src";
import { getDocsHighlighter } from "../src/highlight/highlighter";

describe("runtime MDX parser", () => {
  test("preserves REST endpoint frontmatter metadata", () => {
    const document = parseRuntimeMdx(`---
title: "Get a user"
description: "Return one public user resource."
apiMethod: "GET"
apiPath: "/v1/users/{user_id}"
---

Endpoint details.
`);

    expect(document.frontmatter).toMatchObject({
      title: "Get a user",
      apiMethod: "GET",
      apiPath: "/v1/users/{user_id}",
    });
  });

  test("parses frontmatter, GFM tables, code, and registered components", () => {
    const source = `---
title: Runtime Page
description: Shared parser
keywords:
  - mdx
  - runtime
---

# Runtime Page

<Note type="warning" title="Heads up">
Use the shared parser.
</Note>

| Name | Value |
| --- | --- |
| Doxa | Docs |

\`\`\`ts
const value = "ok";
\`\`\`
`;

    const document = parseRuntimeMdx(source);

    expect(document.frontmatter).toEqual({
      title: "Runtime Page",
      description: "Shared parser",
      keywords: ["mdx", "runtime"],
    });
    expect(document.nodes).toContainEqual(
      expect.objectContaining({ type: "element", name: "table" }),
    );
    expect(document.nodes).toContainEqual(
      expect.objectContaining({ type: "element", name: "Note" }),
    );
  });

  test("rejects unregistered components with their exact name", () => {
    expect(() => parseRuntimeMdx("<Warning>Stop.</Warning>")).toThrow(
      "Unknown MDX component: Warning",
    );
  });

  test("rejects MDX syntax the renderer cannot execute", () => {
    expect(() => parseRuntimeMdx("# Value\n\n{runtimeValue}")).toThrow(
      "Unsupported MDX syntax: mdxFlowExpression",
    );
  });

  test("reads LF and CRLF frontmatter consistently", () => {
    expect(readFrontmatter("---\r\ntitle: Windows\r\n---\r\n# Body")).toEqual({
      frontmatter: {
        title: "Windows",
        description: undefined,
        keywords: undefined,
      },
      content: "# Body",
    });
  });

  test("exports the canonical component registry", () => {
    expect(RUNTIME_MDX_COMPONENT_NAMES).toContain("Note");
    expect(isRuntimeMdxComponentName("Tabs")).toBe(true);
    expect(isRuntimeMdxComponentName("Warning")).toBe(false);
  });

  test("highlights a supported bash fence with token spans", () => {
    const document = parseRuntimeMdx('```bash\necho "hello"\n```', {
      highlighter: getDocsHighlighter(),
    });
    const [pre] = findElements(document.nodes, "pre");

    expect(pre?.props?.className).toContain("shiki");
    expect(findElements(pre?.children ?? [], "span")).not.toHaveLength(0);
  });

  test("preserves the fence language and legacy line metadata", () => {
    const document = parseRuntimeMdx(
      "```ts {2-3} showLineNumbers\nconst first = true;\nconst second = true;\nconst third = true;\n```",
      { highlighter: getDocsHighlighter() },
    );
    const [pre] = findElements(document.nodes, "pre");
    const lines = directElementChildren(
      findElements(pre?.children ?? [], "code")[0],
      "span",
    );

    expect(pre?.props?.["data-language"]).toBe("typescript");
    expect(pre?.props?.className).toContain("highlight-comp");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.props).toMatchObject({
      className: expect.stringContaining("code-line"),
      line: 1,
    });
    expect(lines[0]?.props?.className).toContain("line-number");
    expect(lines[0]?.props?.className).not.toContain("highlight-line");
    expect(lines[1]?.props?.className).toContain("highlight-line");
    expect(lines[2]?.props?.className).toContain("highlight-line");
  });

  test("does not add line numbers unless the fence requests them", () => {
    const document = parseRuntimeMdx("```ts {2}\nfirst();\nsecond();\n```", {
      highlighter: getDocsHighlighter(),
    });
    const [pre] = findElements(document.nodes, "pre");
    const lines = directElementChildren(
      findElements(pre?.children ?? [], "code")[0],
      "span",
    );

    expect(lines[0]?.props?.className).not.toContain("line-number");
    expect(lines[0]?.props).not.toHaveProperty("line");
    expect(lines[1]?.props?.className).toContain("highlight-line");
  });

  test("adds line numbers to plain text fences without loading a grammar", () => {
    const document = parseRuntimeMdx(
      "```text showLineNumbers\nfirst line\nsecond line\n```",
      { highlighter: getDocsHighlighter() },
    );
    const [pre] = findElements(document.nodes, "pre");
    const lines = directElementChildren(
      findElements(pre?.children ?? [], "code")[0],
      "span",
    );

    expect(pre?.props?.["data-language"]).toBe("text");
    expect(lines.map((line) => line.props?.line)).toEqual([1, 2]);
  });

  test("keeps an unknown fence language as plain text", () => {
    const document = parseRuntimeMdx(
      '```kotlin\nfun main() = println("hello")\n```',
      {
        highlighter: getDocsHighlighter(),
      },
    );
    const [pre] = findElements(document.nodes, "pre");

    expect(pre?.props?.className).toBeUndefined();
    expect(pre?.props?.["data-language"]).toBe("kotlin");
    expect(readText(pre)).toBe('fun main() = println("hello")');
  });

  test("keeps a fence without a language as plain text", () => {
    const document = parseRuntimeMdx("```\nplain output\n```", {
      highlighter: getDocsHighlighter(),
    });
    const [pre] = findElements(document.nodes, "pre");

    expect(pre?.props?.className).toBeUndefined();
    expect(readText(pre)).toBe("plain output");
  });

  test("does not highlight when no highlighter is provided", () => {
    const document = parseRuntimeMdx("```bash\necho plain\n```");
    const [pre] = findElements(document.nodes, "pre");

    expect(pre?.props?.className).toBeUndefined();
    expect(findElements(pre?.children ?? [], "span")).toHaveLength(0);
    expect(readText(pre)).toBe("echo plain");
  });

  test("stores the original fence text on highlighted and plain pre nodes", () => {
    const highlighted = parseRuntimeMdx("```bash\necho highlighted\n```", {
      highlighter: getDocsHighlighter(),
    });
    const plain = parseRuntimeMdx("```unknown\nplain text\n```", {
      highlighter: getDocsHighlighter(),
    });

    expect(findElements(highlighted.nodes, "pre")[0]?.props?.raw).toBe(
      "echo highlighted",
    );
    expect(findElements(plain.nodes, "pre")[0]?.props?.raw).toBe("plain text");
  });
});

function findElements(
  nodes: readonly RuntimeMdxNode[],
  name: RuntimeMdxElementNode["name"],
): RuntimeMdxElementNode[] {
  const matches: RuntimeMdxElementNode[] = [];
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.name === name) matches.push(node);
    matches.push(...findElements(node.children ?? [], name));
  }
  return matches;
}

function directElementChildren(
  node: RuntimeMdxNode | undefined,
  name: RuntimeMdxElementNode["name"],
): RuntimeMdxElementNode[] {
  if (!node || node.type !== "element") return [];
  return (node.children ?? []).filter(
    (child): child is RuntimeMdxElementNode =>
      child.type === "element" && child.name === name,
  );
}

function readText(node: RuntimeMdxNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(readText).join("");
}

describe("literal attribute values", () => {
  function chartOf(source: string): unknown {
    const node = parseRuntimeMdx(source).nodes[0] as RuntimeMdxElementNode;
    return node.props?.chart;
  }

  test("reads a template literal chart without its backticks", () => {
    expect(
      chartOf("<Mermaid\n  chart={`graph TD;\n    A --> B;`}\n/>\n"),
    ).toBe("graph TD;\n  A --> B;");
  });

  test("resolves escapes in string and template literals", () => {
    expect(chartOf('<Mermaid chart={"a\\nb \\"c\\""} />\n')).toBe('a\nb "c"');
    expect(chartOf("<Mermaid chart={'it\\'s'} />\n")).toBe("it's");
    expect(chartOf("<Mermaid chart={`a \\` b \\${x}`} />\n")).toBe("a ` b ${x}");
    expect(chartOf('<Mermaid chart={"\\u0041\\x42"} />\n')).toBe("AB");
  });

  test("keeps an expression that is not one literal as its source", () => {
    expect(chartOf("<Mermaid chart={`a ${b}`} />\n")).toBe("`a ${b}`");
    expect(chartOf('<Mermaid chart={"a" + "b"} />\n')).toBe('"a" + "b"');
    expect(chartOf("<Mermaid chart={diagram} />\n")).toBe("diagram");
  });

  test("keeps plain quoted values as before", () => {
    expect(chartOf('<Mermaid chart={"graph LR; A-->B"} />\n')).toBe("graph LR; A-->B");
    expect(chartOf('<Mermaid chart="graph LR; A-->B" />\n')).toBe("graph LR; A-->B");
  });
});

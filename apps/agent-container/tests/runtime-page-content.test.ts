import { parseRuntimeMdx } from "@doxahq/mdx-runtime";
import { describe, expect, test, vi } from "vitest";

import { stripUnsupportedMdxEsm } from "../src/runtime-page-content";

describe("stripUnsupportedMdxEsm", () => {
  test.each([
    '<ApiEndpoint method="POST" path="/v1/flags">\nDetails\n</ApiEndpoint>',
    '<Card title="x">\nDetails\n</Card>',
    '<ApiParam name="id" type="string" required>\nDetails\n</ApiParam>',
  ])("preserves registered component tags in %j", (source) => {
    expect(stripUnsupportedMdxEsm(source)).toBe(`${source}\n`);
  });

  test("preserves imports inside a fenced TypeScript sample", () => {
    const source = '```ts\nimport { A } from "pkg";\n```';

    expect(stripUnsupportedMdxEsm(source)).toBe(`${source}\n`);
  });

  test("keeps an import-only fenced sample non-empty", () => {
    const source = '```js\nimport x from "y";\n```';

    expect(stripUnsupportedMdxEsm(source)).toBe(`${source}\n`);
  });

  test("preserves every line of a multi-line fenced import", () => {
    const source = `\`\`\`ts
import {
  FlagForgeClient,
  type AttributeValue,
} from "@flagforge/sdk";
\`\`\``;

    const result = stripUnsupportedMdxEsm(source);

    expect(result).toContain("import {\n");
    expect(result).toContain('} from "@flagforge/sdk";');
    expect(result.indexOf("import {\n")).toBeLessThan(
      result.indexOf('} from "@flagforge/sdk";'),
    );
  });

  test("does not close a four-backtick fence with three backticks", () => {
    const source = `\`\`\`\`ts
import first from "first";
\`\`\`
import second from "second";
\`\`\`\`
import dropped from "outside";`;

    expect(stripUnsupportedMdxEsm(source)).toBe(`\`\`\`\`ts
import first from "first";
\`\`\`
import second from "second";
\`\`\`\`
`);
  });

  test("preserves an import in a four-space indented code block", () => {
    const source = '    import x from "y";';

    expect(stripUnsupportedMdxEsm(source)).toBe(`${source}\n`);
  });

  test("preserves repeated blank lines inside a fenced block", () => {
    const source = '```ts\nconst first = 1;\n\n\nconst second = 2;\n```';

    expect(stripUnsupportedMdxEsm(source)).toBe(`${source}\n`);
  });

  test("removes a top-level import and reports the dropped line", () => {
    const onDropped = vi.fn();

    expect(
      stripUnsupportedMdxEsm('import x from "y";\n# Page', onDropped),
    ).toBe("# Page\n");
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped).toHaveBeenCalledWith('import x from "y";');
  });

  test("removes a top-level export", () => {
    expect(stripUnsupportedMdxEsm("export const x = 1;\n# Page")).toBe(
      "# Page\n",
    );
  });

  test("leaves script markup unchanged for the runtime parser to escape", () => {
    // The runtime parser converts this markup to a text node.
    const source = "<script>alert(1)</script>";

    expect(stripUnsupportedMdxEsm(source)).toBe(`${source}\n`);
  });
});

describe("runtime MDX security round trip", () => {
  test("accepts a registered REST endpoint component", () => {
    const source = stripUnsupportedMdxEsm(
      '<ApiEndpoint method="GET" path="/x">\nDetails\n</ApiEndpoint>',
    );

    expect(() => parseRuntimeMdx(source)).not.toThrow();
  });

  test("rejects an unregistered component", () => {
    const source = stripUnsupportedMdxEsm("<Evil>hi</Evil>");

    expect(() => parseRuntimeMdx(source)).toThrow(
      "Unknown MDX component: Evil",
    );
  });

  test("rejects executable MDX expressions", () => {
    const source = stripUnsupportedMdxEsm("{process.env.SECRET}");

    expect(() => parseRuntimeMdx(source)).toThrow("Unsupported MDX syntax");
  });

  test("accepts imports shown inside a code fence", () => {
    const source = stripUnsupportedMdxEsm(
      '```ts\nimport { A } from "pkg";\n```',
    );

    expect(() => parseRuntimeMdx(source)).not.toThrow();
  });
});

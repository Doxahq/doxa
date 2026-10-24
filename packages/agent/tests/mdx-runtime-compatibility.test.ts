import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRuntimeMdx,
  RUNTIME_MDX_COMPONENT_NAMES,
} from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import {
  extractMdxComponents,
  loadAllowedComponents,
} from "../src/utils/component-allowlist";
import { compileMdx } from "../src/utils/mdx-compile";
import { runPageValidation } from "../src/utils/page-validator";
import { KNOWN_COMPONENTS } from "../src/utils/page-validator";

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mdx-runtime",
);

const writerComponentNames = [
  "Card",
  "CardGrid",
  "File",
  "FileTree",
  "Folder",
  "Mermaid",
  "Note",
  "Step",
  "StepItem",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
] as const;

describe("generator and renderer MDX compatibility", () => {
  test("accepts the real-generation corpus through both validation surfaces", async () => {
    const fixtureNames = (await readdir(fixtureDirectory)).sort();

    for (const fixtureName of fixtureNames) {
      const source = await readFile(join(fixtureDirectory, fixtureName), "utf8");
      const report = await runPageValidation(source, { minBodyLength: 0 });

      expect(report, fixtureName).toMatchObject({ ok: true, issues: [] });
      expect(() => parseRuntimeMdx(source), fixtureName).not.toThrow();
    }
  });

  test("keeps every writer component in the canonical runtime registry", () => {
    const canonicalNames = new Set<string>(RUNTIME_MDX_COMPONENT_NAMES);
    const allowedNames = loadAllowedComponents();

    for (const componentName of writerComponentNames) {
      expect(canonicalNames.has(componentName), componentName).toBe(true);
      expect(allowedNames.has(componentName), componentName).toBe(true);
    }
  });

  test("uses the runtime component registry as the validator source of truth", () => {
    expect(new Set(KNOWN_COMPONENTS)).toEqual(
      new Set(RUNTIME_MDX_COMPONENT_NAMES),
    );
  });

  test("rejects an unregistered component without repository-specific files", async () => {
    const source = `---
title: Invalid component
description: This page must fail before publication
---

## Warning

<Warning>This component does not exist.</Warning>
`;

    const report = await runPageValidation(source, { minBodyLength: 0 });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        rule: "unknown-component",
        severity: "hard",
        message: expect.stringContaining("<Warning>"),
      }),
    );
    expect(
      report.issues.filter((issue) => issue.message.includes("Warning")),
    ).toHaveLength(1);
  });

  test("ignores component-looking examples inside code fences and inline code", () => {
    const source = `Use \`<Warning>\` only as an example.

\`\`\`mdx
<Callout>Example only.</Callout>
\`\`\`

<Note>Rendered component.</Note>`;

    expect(extractMdxComponents(source)).toEqual(["Note"]);
  });

  test("accepts GFM tables and frontmatter consistently", async () => {
    const source = await readFile(
      join(fixtureDirectory, "configuration.mdx"),
      "utf8",
    );

    await expect(compileMdx(source)).resolves.toEqual({ ok: true, errors: [] });
    expect(parseRuntimeMdx(source).frontmatter).toMatchObject({
      title: "Configuration",
      description: "Environment variables, Prisma setup, and Zod schemas",
    });
  });

  test("rejects runtime-unsupported MDX syntax during generation", async () => {
    const result = await compileMdx("# Runtime expression\n\n{runtimeValue}\n");

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          rule: "mdx-runtime-incompatible",
          severity: "hard",
          message: expect.stringContaining("Unsupported MDX syntax"),
        },
      ],
    });
  });
});

import React from "react";
import { RUNTIME_MDX_COMPONENT_NAMES } from "@doxahq/mdx-runtime";
import { getDocsHighlighter } from "@doxahq/mdx-runtime/highlight";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { components } from "../lib/components";
import type { ContentAdapter } from "../lib/content/types";
import * as runtimeModule from "./index";
import {
  createDoxaDocsRuntime,
  parseRuntimeMdx,
  renderRuntimeMdx,
  RuntimeMdxContent,
} from "./index";
import { runtimeComponents } from "./mdx-components";

describe("portable runtime entrypoint", () => {
  test("does not expose Vite-only runtime source bindings", () => {
    expect(runtimeModule).not.toHaveProperty("createViteRuntimeSource");
    expect(runtimeModule).not.toHaveProperty("viteRuntimeSource");
  });
});

describe("renderRuntimeMdx", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders frontmatter, gfm, code, links, and template components", async () => {
    const rendered = await renderRuntimeMdx(`---
title: Runtime Page
description: Runtime description
---

# Runtime Page

<Note type="warning" title="Heads up">
Watch this.
</Note>

| Name | Value |
| --- | --- |
| Doxa | Docs |

\`\`\`ts
const value = "ok";
\`\`\`
`);

    expect(rendered.frontmatter.title).toBe("Runtime Page");
    expect(rendered.frontmatter.description).toBe("Runtime description");
    expect(rendered.html).toContain('<h1 id="runtime-page">Runtime Page</h1>');
    expect(rendered.html).toContain("doxa-note-warning");
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).toContain("const value");
  });

  test("keeps renderer component implementations aligned with the canonical registry", () => {
    const canonicalNames = [...RUNTIME_MDX_COMPONENT_NAMES].sort();

    expect(Object.keys(runtimeComponents).sort()).toEqual(canonicalNames);
    expect(Object.keys(components).sort()).toEqual(canonicalNames);
  });

  test("parses a serializable runtime tree", () => {
    const document = parseRuntimeMdx(`# Runtime Page

Paragraph with [safe](/safe) and [bad](javascript:alert(1)).

- One
- Two

<Note type="success" title="Good">
Works.
</Note>
`);

    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    expect(document.nodes).toContainEqual({
      type: "element",
      name: "h1",
      props: { id: "runtime-page" },
      children: [{ type: "text", value: "Runtime Page" }],
    });
    expect(document.nodes).toContainEqual({
      type: "element",
      name: "ul",
      children: [
        {
          type: "element",
          name: "li",
          children: [
            {
              type: "element",
              name: "p",
              children: [{ type: "text", value: "One" }],
            },
          ],
        },
        {
          type: "element",
          name: "li",
          children: [
            {
              type: "element",
              name: "p",
              children: [{ type: "text", value: "Two" }],
            },
          ],
        },
      ],
    });
    const html = renderToString(
      React.createElement(RuntimeMdxContent, { document })
    );

    expect(html).toContain('href="#"');
    expect(html).toContain("doxa-note-success");
  });

  test("renders runtime documents through React without HTML injection", () => {
    const document = parseRuntimeMdx("# Safe\n\n<script>alert(1)</script>");
    const html = renderToString(
      React.createElement(RuntimeMdxContent, { document })
    );

    expect(html).toContain('<h1 id="safe">Safe</h1>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("renders highlighted documents through React without a style error", () => {
    const document = parseRuntimeMdx('```bash\necho "safe"\n```', {
      highlighter: getDocsHighlighter(),
    });

    expect(() =>
      renderToString(React.createElement(RuntimeMdxContent, { document }))
    ).not.toThrow();
  });

  test("fails with useful error for unknown components", async () => {
    expect(() => parseRuntimeMdx("<UnknownComponent />")).toThrow(
      "Failed to parse runtime MDX:"
    );
    await expect(renderRuntimeMdx("<UnknownComponent />")).rejects.toThrow(
      "Failed to parse runtime MDX:"
    );
  });

  test("does not require string code generation", async () => {
    vi.stubGlobal("Function", () => {
      throw new Error("codegen blocked");
    });

    const rendered = await renderRuntimeMdx("# Runtime Safe\n\nNo eval.");

    expect(rendered.html).toContain('<h1 id="runtime-safe">Runtime Safe</h1>');
  });
});

describe("createDoxaDocsRuntime", () => {
  test("renders a docs page from a content adapter", async () => {
    const runtime = createDoxaDocsRuntime({
      contentAdapter: createMemoryAdapter({
        "settings/documents.json": JSON.stringify([
          { title: "Intro", href: "/" },
        ]),
        "index.mdx": "---\ntitle: Intro\n---\n\n# Intro\n\nHello.",
      }),
      siteConfig: {
        name: "Doxa Demo",
        description: "Generated docs",
        url: "https://preview.doxa.so/demo",
      },
    });

    const result = await runtime.render({ docsPath: "/", basePath: "/demo" });

    expect(result.status).toBe(200);
    expect(result.html).toContain('<h1 id="intro">Intro</h1>');
    expect(result.html).toContain("Doxa Docs");
    expect(result.html).toContain('href="/demo"');
  });

  test("returns template 404 when content is missing", async () => {
    const runtime = createDoxaDocsRuntime({
      contentAdapter: createMemoryAdapter({}),
      siteConfig: {
        name: "Missing",
        url: "https://preview.doxa.so/missing",
      },
    });

    const result = await runtime.render({
      docsPath: "/missing",
      basePath: "/demo",
    });

    expect(result.status).toBe(404);
    expect(result.html).toContain("Page not found");
  });
});

function createMemoryAdapter(files: Record<string, string>): ContentAdapter {
  return {
    name: "memory",
    async listFiles() {
      return Object.keys(files);
    },
    async readFile(filePath) {
      return files[filePath] ?? null;
    },
  };
}

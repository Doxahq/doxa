import { describe, expect, test } from "vitest";

import {
  applyFrontmatterPolicy,
  buildFrontmatter,
  sanitizeNavTitle,
} from "../src/utils/frontmatter";
import { validatePage } from "../src/utils/page-validator";

describe("frontmatter policy", () => {
  test("retains the existing default title normalization for ordinary pages", () => {
    expect(applyFrontmatterPolicy({
      title: "GET /health",
      description: "Health check endpoint documentation for service monitoring.",
    })).toEqual({
      title: "GET",
      description: "Health check endpoint documentation for service monitoring",
    });
  });

  test("keeps a title that is one file name", () => {
    // The cleanup drops file paths. It once dropped the whole title of a page
    // about `productContext.md`, which then became "Documentation".
    expect(applyFrontmatterPolicy({
      title: "productContext.md",
      description: "The product context file of the Memory Bank.",
    }).title).toBe("productContext.md");
    expect(buildFrontmatter({
      title: "active_context.md",
      description: "The active context file of the Memory Bank.",
    })).toContain('title: "active_context.md"');
  });

  test("accepts a file name title and still rejects a path in other text", () => {
    const page = (title: string) =>
      `---\ntitle: "${title}"\ndescription: "The product context file of the Memory Bank."\n---\n\n## Overview\n\nThe file records why the project exists.\n`;
    const fieldErrors = (title: string) =>
      validatePage(page(title)).errors.filter((error) => error.field === "frontmatter.title");

    expect(fieldErrors("productContext.md")).toEqual([]);
    expect(fieldErrors("Edit src/config.ts")).not.toEqual([]);
  });
});

describe("sidebar labels", () => {
  test("uses a short label when it fits", () => {
    expect(sanitizeNavTitle("Start server", "AI Memory: Start MCP Server")).toBe("Start server");
  });

  test("shows the whole page title instead of cutting a long label", () => {
    expect(sanitizeNavTitle("AI Memory: Start MCP Server", "AI Memory: Start MCP Server"))
      .toBe("AI Memory: Start MCP Server");
    expect(sanitizeNavTitle("A label that is far too long", "Install AI Memory")).toBe("Install AI Memory");
  });

  test("keeps file names, so pages about files do not all read Overview", () => {
    expect(sanitizeNavTitle("productContext.md", "productContext.md")).toBe("productContext.md");
    expect(sanitizeNavTitle("activeContext.md", "activeContext.md")).toBe("activeContext.md");
  });

  test("falls back to Overview only when nothing readable is left", () => {
    expect(sanitizeNavTitle("https://example.com", "src/index.ts")).toBe("Overview");
  });
});

import { describe, expect, it } from "vitest";

import { splitCompiledSearchIndex } from "../src/browser-artifacts";
import { loadBrowserSearchEngine, parseSnippets } from "../src/browser";
import { compileSearchArtifact, type RuntimeSearchArtifact } from "../src/index";

const artifact: RuntimeSearchArtifact = {
  schemaVersion: 1,
  contentVersion: "v1",
  documents: [
    {
      id: "/deploy",
      slug: "/deploy",
      title: "Deployment",
      description: "How to deploy the site.",
      breadcrumb: ["Guides"],
      section: "default",
      headings: ["Cloudflare"],
      keywords: ["release"],
      content: "deploy to cloudflare workers with wrangler",
      lines: [
        { text: "Deployment overview" },
        { text: "Deploy to Cloudflare Workers", anchor: "cloudflare" },
      ],
    },
    {
      id: "/theme",
      slug: "/theme",
      title: "Theme",
      description: "Colors and fonts.",
      breadcrumb: [],
      section: "default",
      headings: [],
      keywords: [],
      content: "change the colors of the site",
      lines: [{ text: "Change the colors" }],
    },
  ],
};

const split = () =>
  splitCompiledSearchIndex(JSON.stringify(compileSearchArtifact(artifact)))!;

describe("browser search", () => {
  it("keeps snippet text out of the index file", () => {
    const files = split();
    expect(files.index).not.toContain("Deploy to Cloudflare Workers");
    expect(files.snippets).toContain("Deploy to Cloudflare Workers");
  });

  it("finds a typo and a partial word", async () => {
    const files = split();
    const engine = await loadBrowserSearchEngine(files.index);
    expect(engine.search("deploymnt")[0]?.slug).toBe("/deploy");
    expect(engine.search("depl")[0]?.slug).toBe("/deploy");
  });

  it("shows the summary until the snippets arrive, then the matching line", async () => {
    const files = split();
    const engine = await loadBrowserSearchEngine(files.index);
    expect(engine.search("cloudflare")[0]).toMatchObject({
      snippetLine: "Deployment overview",
    });
    expect(engine.search("cloudflare")[0]).not.toHaveProperty("snippetAnchor");

    const snippets = parseSnippets(files.snippets);
    expect(snippets).not.toBeNull();
    engine.addSnippets(snippets!);
    expect(engine.search("cloudflare")[0]).toMatchObject({
      snippetLine: "Deploy to Cloudflare Workers",
      snippetAnchor: "cloudflare",
    });
  });

  it("refuses a file of another shape", () => {
    expect(splitCompiledSearchIndex("not json")).toBeNull();
    expect(splitCompiledSearchIndex('{"serializedIndex":"not json"}')).toBeNull();
    expect(splitCompiledSearchIndex('{"serializedIndex":"{}"}')).toBeNull();
  });

  it("treats a broken snippets file as no snippets", () => {
    expect(parseSnippets("not json")).toBeNull();
    expect(parseSnippets("[1]")).toBeNull();
  });
});

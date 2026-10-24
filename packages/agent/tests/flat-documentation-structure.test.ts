import { describe, expect, test } from "vitest";

import { buildDeterministicNavOrderManifest } from "../src/doxa-agent/nav-order";
import { parseStructureResult } from "../src/doxa-agent/json-parsing";
import { prompts } from "../src/doxa-agent/prompts";
import { applyCollectionsToStructure } from "../src/utils/documentation-collections";
import type { DocumentationStructure, ProjectAnalysis } from "../src";
import { analysisFixture } from "./fixtures";

describe("flat documentation structure", () => {
  test("flattens legacy model-authored child pages into grouped sibling pages", () => {
    const structure = parseStructureResult(JSON.stringify({
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [{
          id: "providers",
          title: "Providers",
          description: "Available providers.",
          subPages: [{
            id: "passkey",
            title: "Passkey",
            description: "Configure the passkey provider.",
          }],
        }],
      }],
    }));

    expect(structure.sections[0]?.pages).toEqual([
      expect.objectContaining({ id: "providers", title: "Providers" }),
      expect.objectContaining({
        id: "providers/passkey",
        title: "Passkey",
        group: "Providers",
      }),
    ]);
    expect(JSON.stringify(structure)).not.toContain("subPages");
  });

  test("turns a detected collection into normal grouped pages", () => {
    const structure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [{
          id: "overview",
          title: "Overview",
          description: "Project overview.",
        }],
      }],
    } as DocumentationStructure;
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      documentationCollections: [{
        id: "condition-operators",
        title: "Condition Operators",
        kind: "mixed",
        sourceEvidence: [{ path: "src/operators.ts", kind: "source" }],
        items: ["starts-with", "greater-than", "matches-regex", "in-segment"].map(
          (slug) => ({
            id: `condition-operators/${slug}`,
            slug,
            title: slug.replaceAll("-", " "),
            sourceEvidence: [{ path: "src/operators.ts", kind: "source" as const }],
          }),
        ),
      }],
    };

    const enriched = applyCollectionsToStructure(structure, analysis);
    const collectionPages = enriched.sections[0]?.pages.filter(
      (page) => page.collectionId === "condition-operators",
    ) ?? [];

    expect(collectionPages).toHaveLength(4);
    expect(collectionPages.map((page) => page.group)).toEqual([
      "Condition Operators",
      "Condition Operators",
      "Condition Operators",
      "Condition Operators",
    ]);
    expect(collectionPages.map((page) => page.collectionItemId)).toEqual([
      "condition-operators/starts-with",
      "condition-operators/greater-than",
      "condition-operators/matches-regex",
      "condition-operators/in-segment",
    ]);
    expect(JSON.stringify(enriched)).not.toContain("subPages");
  });

  test("asks the planner for grouped pages and renders those groups directly", async () => {
    const structure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          { id: "overview", title: "Overview", description: "Project overview." },
          {
            id: "providers/passkey",
            title: "Passkey",
            description: "Configure passkey authentication.",
            group: "Providers",
          },
        ],
      }],
    };
    const prompt = prompts.buildStructurePrompt({
      analysis: analysisFixture,
      answers: {},
      maxPages: 10,
    });

    expect(prompt.system).toContain('"group": "Optional navigation group"');
    expect(prompt.system).not.toContain("subPages");

    const manifest = await buildDeterministicNavOrderManifest(structure);
    expect(manifest.sections[0]?.groups).toEqual([
      { heading: "Start Here", items: ["default/overview.md"] },
      { heading: "Providers", items: ["default/providers/passkey.md"] },
    ]);
  });

  test("labels the sidebar with whole titles, file names included", async () => {
    const structure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          { id: "overview", title: "Overview", description: "Project overview." },
          {
            id: "commands/start-mcp-server",
            title: "AI Memory: Start MCP Server",
            description: "Start the MCP server.",
            group: "Commands",
          },
          {
            id: "memory-bank/productcontext",
            title: "productContext.md",
            description: "The product context file.",
            group: "Memory Bank files",
          },
          {
            id: "memory-bank/activecontext",
            title: "activeContext.md",
            description: "The active context file.",
            group: "Memory Bank files",
          },
        ],
      }],
    };

    const manifest = await buildDeterministicNavOrderManifest(structure);
    expect(manifest.navTitles).toMatchObject({
      "default/overview.md": "Overview",
      "default/commands/start-mcp-server.md": "AI Memory: Start MCP Server",
      "default/memory-bank/productcontext.md": "productContext.md",
      "default/memory-bank/activecontext.md": "activeContext.md",
    });
  });
});

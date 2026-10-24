import { describe, expect, test } from "vitest";
import {
  applyStructureReviewDecisions,
  filterPublicReferenceSurfaces,
  normalizeProjectAnalysis,
  validateReviewedStructure,
} from "../src";
import { applyCollectionsToStructure } from "../src/utils/documentation-collections";
import type { DocumentationStructure, ProjectAnalysis } from "../src";
import { analysisFixture } from "./fixtures";

const memoryItems = [
  "Project Brief",
  "Product Context",
  "Tech Context",
  "System Patterns",
  "Active Context",
  "Progress",
];

function aiMemoryAnalysis(): ProjectAnalysis {
  return {
    ...analysisFixture,
    projectName: "AI Memory",
    projectType: "Cursor IDE extension",
    projectCategory: "desktop-app",
    projectProfile: "application",
    summary: "A Cursor extension that gives projects persistent context.",
    projectDescription: "AI Memory helps Cursor users initialize and maintain a project Memory Bank.",
    documentationIntent: {
      audience: "consumer",
      primaryUseCase: "Install the extension and use persistent project context in Cursor.",
      publicPackageNames: [],
      canonicalWorkflows: [],
      internalOnlyPaths: ["src/mcpServer.ts", "src/routes/test.ts"],
      consumerTerminology: ["Memory Bank", "Cursor"],
    },
    documentationCollections: [{
      id: "memory-bank-files",
      title: "Memory Bank Files",
      kind: "docs",
      sourceEvidence: [{ path: "README.md", kind: "readme" }],
      items: memoryItems.map((title) => ({
        id: `memory-bank-files/${title.toLowerCase().replace(/\s+/g, "-")}`,
        title,
        slug: title.toLowerCase().replace(/\s+/g, "-"),
        sourceEvidence: [{ path: `memory-bank/${title}.md`, kind: "docs" }],
      })),
    }],
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        sourceEvidence: [{ path: "src/mcpServer.ts", kind: "source" }],
        groups: [{
          id: "local-server",
          title: "Local Server",
          sourceEvidence: [{ path: "src/mcpServer.ts", kind: "source" }],
          endpoints: ["/health", "/test", "/sse", "/messages"].map((path) => ({
            id: path.slice(1),
            title: path.slice(1),
            method: "GET",
            path,
            description: "Internal extension transport route.",
            sourceEvidence: [{ path: "src/mcpServer.ts", kind: "source" }],
          })),
        }],
      },
    },
  };
}

function aiMemoryStructure(): DocumentationStructure {
  const page = (id: string, title: string, description: string) => ({ id, title, description });
  return {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        page("overview", "Overview", "Understand AI Memory and its public user value."),
        page("quickstart", "Quickstart", "Install AI Memory and initialize a Memory Bank."),
        page("cursor-commands", "Cursor Commands", "Use AI Memory from Cursor."),
        page("memory-bank", "Memory Bank", "Use persistent project context."),
        page("memory-bank-files", "Memory Bank Files", "Understand each persistent context file."),
        page("health-check", "Health Check", "Inspect the local extension server."),
        page("mcp-transport", "MCP Transport", "Understand SSE and message endpoints."),
        page("development", "Development Setup", "Build and test the repository."),
      ],
    }],
  };
}

describe("AI Memory public generation regression", () => {
  test("produces a concise public plan without internal endpoint reference docs", () => {
    const legacyNormalized = normalizeProjectAnalysis({
      ...aiMemoryAnalysis(),
      referenceSurfaces: undefined,
      hasApiRoutes: true,
      apiEndpoints: [{ method: "GET", path: "/health", description: "Internal health route" }],
    });
    expect(legacyNormalized.referenceSurfaces?.rest).toBeUndefined();

    const analysis = filterPublicReferenceSurfaces(aiMemoryAnalysis());
    expect(analysis.referenceSurfaces?.rest).toBeUndefined();

    const enriched = applyCollectionsToStructure(aiMemoryStructure(), analysis);
    const reviewed = applyStructureReviewDecisions(enriched, enriched.sections[0]!.pages.map((entry) => ({
      action: ["health-check", "mcp-transport", "development"].includes(entry.id)
        ? "drop" as const
        : "keep" as const,
      pageId: `documentation/${entry.id}`,
      reason: "Keep public pages and remove repository-only pages.",
    })));

    expect(validateReviewedStructure(reviewed, 10)).toEqual({ valid: true, errors: [] });
    expect(reviewed.sections[0]?.pages.map((entry) => entry.title)).toEqual([
      "Overview",
      "Quickstart",
      "Cursor Commands",
      "Project Brief",
      "Product Context",
      "Tech Context",
      "System Patterns",
      "Active Context",
      "Progress",
    ]);
    expect(reviewed.sections[0]?.pages.filter((entry) => entry.collectionId === "memory-bank-files")).toHaveLength(6);
    expect(JSON.stringify(reviewed)).not.toMatch(/health|sse|messages|development setup/i);
  });
});

import { describe, expect, test } from "vitest";
import {
  buildRouteRegistry,
  keepPublishedRoutes,
  applyInstructionEdits,
  type DocumentationStructure,
} from "../src";
import { buildWriterPrompt } from "../src/doxa-agent/prompts/dynamic/builders";
import { analysisFixture } from "./fixtures";

function structure(pages: DocumentationStructure["sections"][number]["pages"]): DocumentationStructure {
  return { sections: [{ id: "default", title: "Documentation", default: true, pages }] };
}

const page = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  description: id,
  sourceEvidence: [],
  ...extra,
});

const routes = (value: DocumentationStructure) => buildRouteRegistry(value).entries.map((entry) => entry.route);

describe("keepPublishedRoutes", () => {
  // The FlagForge case: the page ID is overview02, the live site serves it at /overview.
  const published = structure([page("overview02", { canonicalRoute: "/overview" }), page("quickstart")]);

  test("a page the new plan kept keeps its published route", () => {
    const replanned = structure([page("overview02"), page("quickstart")]);

    expect(routes(keepPublishedRoutes(replanned, published))).toEqual(["/overview", "/quickstart"]);
  });

  test("the plan still drops and adds pages", () => {
    const replanned = structure([page("overview02"), page("flagforge-alternatives")]);

    expect(routes(keepPublishedRoutes(replanned, published))).toEqual(["/overview", "/flagforge-alternatives"]);
  });

  test("a new page that would take a kept route gets a free one", () => {
    const replanned = structure([page("overview02"), page("overview")]);

    expect(routes(keepPublishedRoutes(replanned, published))).toEqual(["/overview", "/overview-2"]);
  });

  test("a page moved to another section is a new page", () => {
    const replanned: DocumentationStructure = {
      sections: [
        { id: "default", title: "Documentation", default: true, pages: [page("quickstart")] },
        { id: "guides", title: "Guides", pages: [page("overview02")] },
      ],
    };

    expect(routes(keepPublishedRoutes(replanned, published))).toEqual(["/quickstart", "/guides/overview02"]);
  });

  test("without a published structure nothing changes", () => {
    const replanned = structure([page("overview02")]);

    expect(keepPublishedRoutes(replanned, null)).toBe(replanned);
  });
});

describe("applyInstructionEdits", () => {
  const previousPages = [
    { pageId: "default/overview02", artifactKey: "v1/overview02.mdx" },
    { pageId: "default/quickstart", artifactKey: "v1/quickstart.mdx" },
    { pageId: "default/endpoint", artifactKey: "v1/endpoint.mdx" },
  ];
  const plan = {
    analysisMode: "full" as const,
    structureMode: "regenerate" as const,
    regeneratePageIds: ["default/flagforge-alternatives"],
    reusePageIds: ["default/overview02", "default/quickstart", "default/endpoint"],
    removedPageIds: [],
    modelCallsRequired: true,
    reasons: ["Page default/flagforge-alternatives is new."],
  };
  const currentPageIds = ["default/overview02", "default/quickstart", "default/flagforge-alternatives", "default/endpoint"];

  test("every kept page moves from reuse to an edit of its published text, and template pages render again", () => {
    const result = applyInstructionEdits({
      plan,
      currentPageIds,
      previousPages,
      edits: {},
      templatePageIds: new Set(["default/endpoint"]),
    });

    // Code renders the endpoint page, so it gets no edit, but it is written
    // again: the instructions steer it too, such as the order of samples.
    expect(result.regeneratePageIds).toEqual([
      "default/overview02",
      "default/quickstart",
      "default/flagforge-alternatives",
      "default/endpoint",
    ]);
    expect(result.reusePageIds).toEqual([]);
    expect(result.pageEdits).toEqual({
      "default/overview02": { artifactKey: "v1/overview02.mdx", changedSources: [], instructionsChanged: true },
      "default/quickstart": { artifactKey: "v1/quickstart.mdx", changedSources: [], instructionsChanged: true },
    });
    expect(result.reasons[0]).toBe("The project instructions changed.");
    expect(result.editReason).toBe("instructions_changed");
  });

  test("a page with source changes keeps its changed files", () => {
    const result = applyInstructionEdits({
      plan,
      currentPageIds,
      previousPages,
      edits: { "default/overview02": { artifactKey: "v1/overview02.mdx", changedSources: ["README.md"] } },
    });

    expect(result.pageEdits["default/overview02"]).toEqual({
      artifactKey: "v1/overview02.mdx",
      changedSources: ["README.md"],
      instructionsChanged: true,
    });
  });
});

describe("writer prompt for an instructions edit", () => {
  const writerPrompt = (instructionsChanged: boolean) =>
    buildWriterPrompt({
      analysis: analysisFixture,
      sectionTitle: "Documentation",
      page: { id: "overview02", title: "Overview", description: "Overview", sourceEvidence: [] },
      previousPage: { content: "## Key features\n\nFast flags.", changedSources: [], instructionsChanged },
    }).user;

  test("an instructions edit lets the writer change what the instructions ask, and keep the rest", () => {
    const prompt = writerPrompt(true);

    expect(prompt).toContain("The project instructions changed since this page was published.");
    expect(prompt).toContain("If the instructions ask nothing of this page, return it as published.");
    expect(prompt).not.toContain("Do not reword, reorder, or restyle");
    expect(prompt).toContain("Fast flags.");
  });

  test("a source edit keeps the word-for-word rules", () => {
    expect(writerPrompt(false)).toContain("Do not reword, reorder, or restyle text that the source still confirms.");
  });
});

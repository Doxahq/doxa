import { describe, expect, test } from "vitest";
import type { ChatRequest, ChatResponse, ChatStreamEvent, Provider } from "../src/core";
import { parseStructureResult } from "../src/doxa-agent/json-parsing";
import { generateStructureWithRetry } from "../src/doxa-agent/structure-runner";
import type { DocumentationStructure } from "../src";
import { sanitizeNavTitle } from "../src/utils/frontmatter";
import { pageTitleProblem, plannedPageTitleErrors } from "../src/utils/page-title-rules";
import { analysisFixture } from "./fixtures";

const OVERVIEW_DESCRIPTION =
  "Project overview covering goals, audience, and high-level capabilities in clear terms.";

function planWithTitles(titles: readonly string[]): string {
  return JSON.stringify({
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: titles.map((title, index) => ({
        id: `page-${index}`,
        title,
        description: OVERVIEW_DESCRIPTION,
      })),
    }],
  });
}

describe("title cleanup", () => {
  test("keeps the closing parenthesis of a pair", () => {
    expect(sanitizeNavTitle("Advanced (JSON)", "Advanced (JSON)")).toBe("Advanced (JSON)");
    expect(sanitizeNavTitle("Advanced (JSON).", "Advanced (JSON).")).toBe("Advanced (JSON)");
    expect(sanitizeNavTitle("(Beta) Search", "(Beta) Search")).toBe("(Beta) Search");
  });

  test("still removes a parenthesis without its pair, and an empty pair", () => {
    expect(sanitizeNavTitle("Setup (", "Setup (")).toBe("Setup");
    expect(sanitizeNavTitle("Install)", "Install)")).toBe("Install");
    expect(sanitizeNavTitle("Values ()", "Values ()")).toBe("Values");
  });
});

describe("page title rules", () => {
  test("accept short titles and pairs that are one subject", () => {
    for (const title of ["Quickstart", "Overview", "SEO and sharing", "Roles and permissions", "Publish a site"]) {
      expect(pageTitleProblem(title)).toBeNull();
    }
  });

  test("reject long titles, lists, and two subjects joined by and", () => {
    expect(pageTitleProblem("Create a Project and Publish Your First Site")).toContain("more than 5 words");
    expect(pageTitleProblem("Branches, Previews, Publishing, and Restore")).toContain("more than 5 words");
    expect(pageTitleProblem("Branches, Previews")).toContain("more than one subject");
    expect(pageTitleProblem("Search & filters")).toContain("more than one subject");
    expect(pageTitleProblem("Generations and Doxabot Instructions")).toContain('"and"');
  });

  test("check only the titles that the planner chose", () => {
    const structure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          { id: "a", title: "Editing Pages in the Content Editor", description: OVERVIEW_DESCRIPTION },
          {
            id: "b",
            title: "A Collection Item With A Long Name",
            description: OVERVIEW_DESCRIPTION,
            collectionId: "items",
          },
          {
            id: "c",
            title: "Get the status of a long running job",
            description: OVERVIEW_DESCRIPTION,
            reference: { kind: "rest", groupId: "jobs", endpointId: "get-job" },
          },
        ],
      }],
    };

    expect(plannedPageTitleErrors(structure)).toEqual([
      expect.stringContaining('"Editing Pages in the Content Editor"'),
    ]);
  });
});

describe("planned page ids", () => {
  test("drop a copied section id, so a published page keeps its route", () => {
    const structure = parseStructureResult(JSON.stringify({
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          { id: "documentation/overview", title: "Overview", description: OVERVIEW_DESCRIPTION },
          { id: "currents/teams", title: "Teams", description: OVERVIEW_DESCRIPTION },
        ],
      }],
    }));

    expect(structure.sections[0]?.pages.map((page) => page.id)).toEqual(["overview", "currents/teams"]);
  });
});

describe("planner retries for titles", () => {
  test("sends a title that breaks the rules back to the planner", async () => {
    const provider = new SequenceProvider([
      planWithTitles(["Generations and Doxabot Instructions"]),
      planWithTitles(["Generations", "Doxabot instructions"]),
    ]);

    const structure = await generateStructureWithRetry(provider, {
      analysis: analysisFixture,
      answers: {},
      maxPages: 12,
    });

    expect(provider.requests).toHaveLength(2);
    expect(userMessageOf(provider.requests[1])).toContain('Page title "Generations and Doxabot Instructions"');
    expect(structure.sections[0]?.pages.map((page) => page.title)).toEqual(["Generations", "Doxabot instructions"]);
  });

  test("keeps a long title on the last attempt, so a title never fails the run", async () => {
    const longTitle = "Create a Project and Publish Your First Site";
    const provider = new SequenceProvider([
      planWithTitles([longTitle]),
      planWithTitles([longTitle]),
      planWithTitles([longTitle]),
    ]);

    const structure = await generateStructureWithRetry(provider, {
      analysis: analysisFixture,
      answers: {},
      maxPages: 12,
    });

    expect(provider.requests).toHaveLength(3);
    expect(structure.sections[0]?.pages.map((page) => page.title)).toEqual([longTitle]);
  });
});

function userMessageOf(request: ChatRequest | undefined): string {
  return String(request?.messages.find((message) => message.role === "user")?.content ?? "");
}

class SequenceProvider implements Provider {
  readonly config = {
    baseUrl: "https://example.test",
    apiKey: "test",
    model: "test-model",
  };
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: this.responses.shift() ?? "",
      },
    };
  }

  async *chatStream(_request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return;
  }
}

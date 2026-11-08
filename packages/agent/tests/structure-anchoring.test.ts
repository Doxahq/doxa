import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Provider,
} from "../src/core";
import { generateStructureWithRetry } from "../src/doxa-agent/structure-runner";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture, structureFixture } from "./fixtures";

const COLD_STRUCTURE_PROMPT_HASH =
  "4b032edf932b10c570afed69e475ce014d2a2a04250fb84c893488df6454c3ab";
const COLD_REVIEW_PROMPT_HASH =
  "988cb6cc193f043c77beb2377084ac0f3d75878573a497e33fa196a1ea5cb598";

describe("published structure anchoring", () => {
  test("includes every published page and the continuity rules in structure generation", () => {
    const prompt = prompts.buildStructurePrompt({
      analysis: analysisFixture,
      answers: {},
      maxPages: 12,
      publishedStructure: structureFixture,
      changedFiles: ["src/index.ts"],
    });

    expectPublishedPages(prompt.user, "plan");
    expect(prompt.user).toContain("Reuse the exact id and title");
    expect(prompt.user).toContain("Do not rename for style, clarity, or consistency");
    expect(prompt.user).toContain("Reuse the exact description verbatim");
    expect(prompt.user).toContain("Keep each page in its published section, in its published order");
    expect(prompt.user).toContain("Add a page only for a public surface");
    expect(prompt.user).toContain("Drop a published page only when its subject no longer exists");
    expect(prompt.user).toContain("changed-file list is the only justification");
    expect(prompt.user).toContain("src/index.ts");
  });

  test("keeps the cold-start structure prompt byte-identical", () => {
    const prompt = prompts.buildStructurePrompt({
      analysis: analysisFixture,
      answers: {},
      maxPages: 12,
    });

    expect(hash(prompt.user)).toBe(COLD_STRUCTURE_PROMPT_HASH);
  });

  test("includes every published page and the keep bias in structure review", () => {
    const prompt = prompts.buildStructureReviewPrompt({
      analysis: analysisFixture,
      structure: structureFixture,
      maxPages: 12,
      publishedStructure: structureFixture,
      changedFiles: ["src/index.ts"],
    });

    expectPublishedPages(prompt.user, "review");
    expect(prompt.user).toContain("must be keep");
    expect(prompt.user).toContain(
      "drop, merge, or move on a published page requires a reason",
    );
    expect(prompt.user).toContain("changed file");
    expect(prompt.user).toContain("removed source surface");
    expect(prompt.user).toContain("src/index.ts");
  });

  test("keeps the cold-start structure review prompt byte-identical", () => {
    const prompt = prompts.buildStructureReviewPrompt({
      analysis: analysisFixture,
      structure: structureFixture,
      maxPages: 12,
    });

    expect(hash(prompt.user)).toBe(COLD_REVIEW_PROMPT_HASH);
  });

  test("preserves the published anchor when structure validation retries", async () => {
    const provider = new SequenceProvider([
      "{}",
      JSON.stringify({
        sections: [
          {
            id: "default",
            title: "Documentation",
            default: true,
            pages: [
              {
                id: "overview",
                title: "Overview",
                description:
                  "Project overview covering goals, audience, and high-level capabilities in clear terms.",
              },
            ],
          },
        ],
      }),
    ]);

    await generateStructureWithRetry(provider, {
      analysis: analysisFixture,
      answers: {},
      maxPages: 12,
      publishedStructure: structureFixture,
      changedSourcePaths: ["src/index.ts"],
    });

    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      const userMessage = request.messages.find(
        (message) => message.role === "user",
      );
      expectPublishedPages(String(userMessage?.content), "plan");
      expect(userMessage?.content).toContain("src/index.ts");
    }
  });
});

/**
 * The planner sees each published page id as it is, because it reuses ids.
 * The review names pages by `section/page`, the form of its decisions.
 */
function expectPublishedPages(prompt: string, identity: "plan" | "review"): void {
  for (const section of structureFixture.sections) {
    for (const page of section.pages) {
      if (identity === "plan") {
        expect(prompt).toContain(`"id": ${JSON.stringify(page.id)}`);
        expect(prompt).not.toContain(`"pageId": ${JSON.stringify(`${section.id}/${page.id}`)}`);
      } else {
        expect(prompt).toContain(`"pageId": ${JSON.stringify(`${section.id}/${page.id}`)}`);
      }
      expect(prompt).toContain(page.title);
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

  async *chatStream(
    _request: ChatRequest,
  ): AsyncIterable<ChatStreamEvent> {
    return;
  }
}

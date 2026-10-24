import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  applyMdxRepairPatch,
  classifyTargetedRepairIssue,
  lineColumnToOffset,
  repairMdxWithModel,
  validateMdxRepairPatch,
} from "../src";
import type { Provider } from "../src";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("targeted MDX repair", () => {
  test("treats description validation as ordinary frontmatter repair", () => {
    expect(classifyTargetedRepairIssue(
      {
        rule: "frontmatter.description",
        severity: "hard",
        message: "Description is invalid.",
        hint: "Use a concise plain-text description.",
      },
      "---\ndescription: \"Invalid\"\n---\n",
      ["frontmatter"],
    )).toMatchObject({
      repairClass: "frontmatter",
      issue: {
        line: 1,
        col: 1,
      },
    });
  });

  test("converts Unicode line and column positions to UTF-16 offsets", () => {
    const source = "first\n🚀 Use <25 ms.\nlast";
    expect(lineColumnToOffset(source, 2, 8)).toBe(
      source.indexOf("2"),
    );
  });

  test("uses three model attempts against one immutable draft", async () => {
    const draft = "# Limits\n\nRequests finish in <25 ms.";
    const prompts: string[] = [];
    const provider = providerReturning(
      ["not json", "still not json", "also not json"],
      prompts,
    );

    const result = await repairMdxWithModel({
      provider,
      draft,
      issue: {
        rule: "unexpected-character",
        line: 3,
        column: 21,
        message: "Unexpected character `2` before name",
      },
      pageId: "limits",
      pageTitle: "Limits",
      pageRetry: 0,
      writerAttempt: 1,
      maxAttempts: 3,
      validate: async () => ({ ok: false, issueCodes: ["unexpected-character"] }),
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(3);
    expect(prompts).toHaveLength(3);
    expect(prompts.every((prompt) => prompt.includes(`Draft SHA-256: ${sha256(draft)}`)))
      .toBe(true);
    expect(prompts.map((prompt) => prompt.match(/Targeted repair attempt (\d)\/3/)?.[1]))
      .toEqual(["1", "2", "3"]);
    expect(prompts[1]).toContain("Previous patch rejected:");
  });

  test("revalidates model patches and can recover on the third attempt", async () => {
    const draft = "# Limits\n\nRequests finish in <25 ms.";
    const startOffset = draft.indexOf("<");
    const validPatch = JSON.stringify({
      draftSha256: sha256(draft),
      startOffset,
      endOffset: startOffset + 1,
      replacement: "&lt;",
      explanation: "Escape the prose less-than character.",
    });
    const prompts: string[] = [];
    const provider = providerReturning(["not json", validPatch, validPatch], prompts);
    let validationCalls = 0;

    const result = await repairMdxWithModel({
      provider,
      draft,
      issue: {
        rule: "unexpected-character",
        line: 3,
        column: 21,
        message: "Unexpected character `2` before name",
      },
      pageId: "limits",
      pageTitle: "Limits",
      pageRetry: 0,
      writerAttempt: 1,
      maxAttempts: 3,
      validate: async () => {
        validationCalls++;
        return validationCalls === 1
          ? { ok: false, issueCodes: ["unexpected-character"] }
          : { ok: true, issueCodes: [] };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      content: "# Limits\n\nRequests finish in &lt;25 ms.",
      attempts: [
        { attempt: 1, accepted: false },
        {
          attempt: 2,
          accepted: false,
          validationIssueCodes: ["unexpected-character"],
        },
        { attempt: 3, accepted: true },
      ],
    });
    expect(prompts[2]).toContain(
      "Previous patch rejected: patched-page-validation-failed:unexpected-character",
    );
  });

  test("rejects stale, distant, and oversized model patches", () => {
    const draft = "# Limits\n\nRequests finish in <25 ms.";
    const parserOffset = draft.indexOf("2");
    const base = {
      draftSha256: sha256(draft),
      startOffset: draft.indexOf("<"),
      endOffset: draft.indexOf("<") + 1,
      replacement: "&lt;",
      explanation: "Escape prose less-than.",
    };

    expect(validateMdxRepairPatch({ draft, parserOffset, patch: base }).ok).toBe(true);
    expect(validateMdxRepairPatch({
      draft,
      parserOffset,
      patch: { ...base, draftSha256: "0".repeat(64) },
    }).ok).toBe(false);
    expect(validateMdxRepairPatch({
      draft,
      parserOffset,
      patch: { ...base, startOffset: 0, endOffset: 1 },
    }).ok).toBe(false);
    expect(validateMdxRepairPatch({
      draft,
      parserOffset,
      patch: { ...base, replacement: "x".repeat(2_049) },
    }).ok).toBe(false);
  });

  test("applies a valid bounded patch", () => {
    const draft = "# Limits\n\nRequests finish in <25 ms.";
    const startOffset = draft.indexOf("<");
    expect(applyMdxRepairPatch(draft, {
      draftSha256: sha256(draft),
      startOffset,
      endOffset: startOffset + 1,
      replacement: "&lt;",
      explanation: "Escape prose less-than.",
    })).toBe("# Limits\n\nRequests finish in &lt;25 ms.");
  });
});

function providerReturning(outputs: string[], prompts: string[]): Provider {
  let index = 0;
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "writer",
    },
    chat: async (request) => {
      prompts.push(request.messages.at(-1)?.content ?? "");
      return {
        message: {
          role: "assistant",
          content: outputs[index++] ?? outputs.at(-1) ?? "",
        },
        finishReason: "stop",
        model: "writer",
      };
    },
    chatStream: async function* () {
      throw new Error("Unexpected stream call");
    },
  };
}

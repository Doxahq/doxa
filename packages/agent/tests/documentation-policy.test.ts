import { describe, expect, test } from "vitest";
import {
  documentationBriefFingerprint,
  MAX_PROJECT_CONTEXT_LENGTH,
  resolveDocumentationBrief,
  resolveDocumentationPolicy,
  normalizeProjectAnalysis,
} from "../src";

describe("public documentation policy", () => {
  test("defaults every caller to the public-v1 policy", () => {
    const brief = resolveDocumentationBrief();

    expect(brief).toEqual({ target: { kind: "public" } });
    expect(resolveDocumentationPolicy(brief)).toMatchObject({
      target: { kind: "public" },
      version: "public-v1",
    });
  });

  test("normalizes optional project context", () => {
    const brief = resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "  Focus on SDK adopters.\r\n\r\nUse concise prose.  ",
    });

    expect(brief.projectContext).toBe("Focus on SDK adopters.\n\nUse concise prose.");
  });

  test("omits empty normalized project context", () => {
    expect(resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: " \n\t ",
    })).toEqual({ target: { kind: "public" } });
  });

  test("rejects control characters and oversized context", () => {
    expect(() => resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "bad\u0000context",
    })).toThrow(/control characters/i);

    expect(() => resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "x".repeat(MAX_PROJECT_CONTEXT_LENGTH + 1),
    })).toThrow(/10,000 characters/i);
  });

  test("fingerprints normalized context without exposing it", () => {
    const first = resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: " Focus on API consumers. ",
    });
    const equivalent = resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "Focus on API consumers.",
    });
    const different = resolveDocumentationBrief({
      target: { kind: "public" },
      projectContext: "Focus on SDK consumers.",
    });

    expect(documentationBriefFingerprint(first)).toBe(documentationBriefFingerprint(equivalent));
    expect(documentationBriefFingerprint(first)).not.toBe(documentationBriefFingerprint(different));
    expect(documentationBriefFingerprint(first)).not.toContain("API consumers");
  });

  test("normalizes public editorial guidance from analysis", () => {
    const analysis = normalizeProjectAnalysis({
      projectName: "Fixture",
      publicEditorialBrief: {
        productPositioning: "A focused TypeScript SDK.",
        intendedReaders: ["SDK developers", 42],
        readerGoals: ["Integrate quickly"],
        focusAreas: ["Authentication"],
        deprioritizedAreas: ["Repository internals"],
        preferredTone: "Concise and expert",
        preferredTerminology: ["workspace"],
      },
    });

    expect(analysis.publicEditorialBrief).toEqual({
      productPositioning: "A focused TypeScript SDK.",
      intendedReaders: ["SDK developers"],
      readerGoals: ["Integrate quickly"],
      focusAreas: ["Authentication"],
      deprioritizedAreas: ["Repository internals"],
      preferredTone: "Concise and expert",
      preferredTerminology: ["workspace"],
    });
  });
});

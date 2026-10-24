import { describe, expect, test } from "vitest";

import { isDocsPreviewGateEnabled } from "../../src/env";
import { resolveDocsAccessPolicy } from "../../src/services/docs-access";
import { resolvePreviewChannelAccessPolicy } from "../../src/repositories/preview-channels";

describe("resolveDocsAccessPolicy", () => {
  test.each([false, true])(
    "keeps production documentation public when gateEnabled is %s",
    (gateEnabled) => {
      expect(
        resolveDocsAccessPolicy({
          isGenerationPreview: false,
          previewVisibility: "private",
          gateEnabled,
        }),
      ).toBe("public");
    },
  );

  test("serves a private generation preview publicly while the gate is off", () => {
    expect(
      resolveDocsAccessPolicy({
        isGenerationPreview: true,
        previewVisibility: "private",
        gateEnabled: false,
      }),
    ).toBe("public");
  });

  test("requires authentication for a private generation preview when the gate is on", () => {
    expect(
      resolveDocsAccessPolicy({
        isGenerationPreview: true,
        previewVisibility: "private",
        gateEnabled: true,
      }),
    ).toBe("authenticated");
  });

  test("allows public generation previews", () => {
    expect(
      resolveDocsAccessPolicy({
        isGenerationPreview: true,
        previewVisibility: "public",
        gateEnabled: true,
      }),
    ).toBe("public");
  });
});

describe("isDocsPreviewGateEnabled", () => {
  test("enables the gate only for the exact true value", () => {
    expect(isDocsPreviewGateEnabled("true")).toBe(true);
  });

  test.each([undefined, "", "false", "TRUE", "1", " true "])(
    "keeps the gate off for %s",
    (value) => {
      expect(isDocsPreviewGateEnabled(value)).toBe(false);
    },
  );
});

describe("preview channel access", () => {
  test("keeps source change channels on their current public policy", () => {
    expect(
      resolvePreviewChannelAccessPolicy({
        kind: "source_change",
        previewVisibility: "private",
        gateEnabled: true,
      }),
    ).toBe("public");
  });

  test("uses the generation preview policy for branch channels", () => {
    expect(
      resolvePreviewChannelAccessPolicy({
        kind: "branch",
        previewVisibility: "private",
        gateEnabled: true,
      }),
    ).toBe("authenticated");
  });
});

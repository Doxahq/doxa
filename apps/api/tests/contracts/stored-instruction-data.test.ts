import { DEFAULT_DOXABOT_INSTRUCTIONS, generationInstructionsSchema } from "@doxahq/contracts";
import { ownedPageFlagSchema, storedOwnedPageFlagSchema } from "@doxahq/contracts/generation-reviews";
import { describe, expect, test } from "vitest";

describe("data stored by another release", () => {
  test("a review flag with a field from a newer release still reads", () => {
    const stored = { href: "/auth", title: "Auth", changedPaths: [], instructionsChanged: true, reason: "future" };

    expect(ownedPageFlagSchema.safeParse(stored).success).toBe(false);
    expect(storedOwnedPageFlagSchema.parse(stored)).toEqual({
      href: "/auth",
      title: "Auth",
      changedPaths: [],
      instructionsChanged: true,
    });
  });

  test("a run context written before the stricter glob rules still parses", () => {
    const context = {
      version: 4,
      instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, doNotDocument: ["./internal/**", "src/[ab]/**"] },
      screening: { method: "heuristic", flags: [] },
      repositoryFile: { status: "disabled" },
    };

    expect(generationInstructionsSchema.parse(context).instructions.doNotDocument).toEqual(["internal/**"]);
  });
});

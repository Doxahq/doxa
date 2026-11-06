import { describe, expect, test } from "vitest";
import { generationStartResultSchema } from "@doxahq/contracts";

describe("generation start contract", () => {
  test("accepts a no-change confirmation without a generation job", () => {
    const result = {
      job: null,
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message:
        "The repository content, Doxabot instructions, and generation configuration have not changed since the current production deployment. A new generation will likely produce the same documentation.",
    };

    expect(generationStartResultSchema.parse(result)).toEqual(result);
  });
});

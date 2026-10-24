import { describe, expect, test } from "vitest";
import { prepareWorkingChanges } from "../../src/services/docs-branches/working-changes";

describe("working change preparation", () => {
  test("uses UTF-8 bytes for the page size limit", async () => {
    await expect(prepareWorkingChanges({
      store: { read: async () => null },
      basePrefix: "sites/site/versions/base",
      existing: [],
      desired: new Map([["source/index.mdx", "😀".repeat(200_000)]]),
    })).rejects.toMatchObject({ code: "invalid" });
  });

  test("rejects a path outside the branch overlay", async () => {
    await expect(prepareWorkingChanges({
      store: { read: async () => null },
      basePrefix: "sites/site/versions/base",
      existing: [],
      desired: new Map([["source/../manifest.json", "bad"]]),
    })).rejects.toThrow();
  });
});

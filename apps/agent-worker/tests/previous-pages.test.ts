import { describe, expect, test } from "vitest";

import { readPreviousPages } from "../src/previous-pages";

const pageEdits = {
  "default/projects": { artifactKey: "v1/projects.mdx", changedSources: ["src/routes/environments.ts"] },
  "default/gone": { artifactKey: "v1/gone.mdx", changedSources: [] },
};

describe("previous pages", () => {
  test("reads the published pages that the write group edits", async () => {
    const reads: string[] = [];
    const read = async (key: string) => {
      reads.push(key);
      return key === "v1/projects.mdx" ? "## Environments" : null;
    };

    const pages = await readPreviousPages(read, pageEdits, ["default/projects", "default/gone", "default/new"]);

    expect(pages).toEqual({
      "default/projects": { content: "## Environments", changedSources: ["src/routes/environments.ts"] },
    });
    expect(reads.sort()).toEqual(["v1/gone.mdx", "v1/projects.mdx"]);
  });

  test("reads nothing for a plan without edits", async () => {
    await expect(readPreviousPages(async () => "x", undefined, ["default/projects"])).resolves.toEqual({});
  });
});

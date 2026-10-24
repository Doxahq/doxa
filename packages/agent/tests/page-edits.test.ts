import { describe, expect, test } from "vitest";

import { planPageEdits } from "../src";
import type { PageDependencyState } from "../src/state/types";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture } from "./fixtures";

function dependencies(sourceFilesRead: string[]): PageDependencyState {
  return {
    sourceFilesRead,
    sourceFilesDiscovered: [],
    sourceEvidenceFiles: [],
    referencedSymbols: [],
    referencedRoutes: [],
  };
}

const previousPages = [
  { pageId: "default/projects", artifactKey: "versions/v1/source/projects/index.mdx", dependencies: dependencies(["src/routes/environments.ts", "src/app.ts"]) },
  { pageId: "default/auth", artifactKey: "versions/v1/source/auth/index.mdx", dependencies: dependencies(["src/plugins/auth.ts"]) },
  { pageId: "rest-api/get-environments", artifactKey: "versions/v1/source/rest-api/get-environments/index.mdx", dependencies: dependencies(["src/routes/environments.ts"]) },
];

describe("page edits", () => {
  test("edits each regenerated page that the baseline has, with the changed files it depends on", () => {
    const edits = planPageEdits({
      plan: {
        regeneratePageIds: ["default/projects", "default/auth", "default/new-guide", "rest-api/get-environments"],
        causes: { newPages: 1, inputChanged: 1, dependencyChanged: 2 },
      },
      previousPages,
      currentEvidencePaths: { "default/auth": ["src/plugins/auth.ts", "src/schemas/keys.ts"] },
      changedPaths: new Set(["src/routes/environments.ts", "src/schemas/keys.ts"]),
      templatePageIds: new Set(["rest-api/get-environments"]),
    });

    expect(edits).toEqual({
      "default/projects": { artifactKey: "versions/v1/source/projects/index.mdx", changedSources: ["src/routes/environments.ts"] },
      "default/auth": { artifactKey: "versions/v1/source/auth/index.mdx", changedSources: ["src/schemas/keys.ts"] },
    });
  });

  test("edits nothing when the plan rewrites every page on purpose", () => {
    expect(planPageEdits({
      plan: { regeneratePageIds: ["default/projects", "default/auth"] },
      previousPages,
      currentEvidencePaths: {},
      changedPaths: new Set(["src/routes/environments.ts"]),
    })).toEqual({});
  });

  test("puts the published page and the changed files in the writer prompt", () => {
    const page = { id: "projects", title: "Projects and environments", description: "Organize flags by project and environment." };
    const previousPage = {
      content: "---\ntitle: Projects and environments\n---\n\n## Environments\n\nEach project has environments.",
      changedSources: ["src/routes/environments.ts"],
    };

    const prompt = prompts.buildWriterPrompt({ analysis: analysisFixture, sectionTitle: "Docs", page, previousPage });

    expect(prompt.user).toContain("PUBLISHED VERSION OF THIS PAGE");
    expect(prompt.user).toContain("Changed files this page depends on: src/routes/environments.ts");
    expect(prompt.user).toContain("<published-page>\n## Environments\n\nEach project has environments.\n</published-page>");
    expect(prompt.user).not.toContain("title: Projects and environments\n---");
  });

  test("lets a seeded owner page take the place of a published page", () => {
    const page = { id: "install", title: "Install", description: "Install the product and verify it runs." };

    const prompt = prompts.buildWriterPrompt({
      analysis: analysisFixture,
      sectionTitle: "Docs",
      page,
      seedPageText: "Run the installer.",
      previousPage: { content: "Old page.", changedSources: [] },
    });

    expect(prompt.user).toContain("EXISTING PAGE FROM THE SITE OWNER");
    expect(prompt.user).not.toContain("PUBLISHED VERSION OF THIS PAGE");
  });
});

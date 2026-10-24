import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createRuntimeDocsArtifacts,
  DOCS_ARTIFACT_SCHEMA_VERSION,
} from "@doxahq/docs-engine";
import { listFrozenArtifactSets } from "../src";
import { recipeSchema } from "../scripts/recipe";

const recipesDirectory = fileURLToPath(new URL("../recipes/", import.meta.url));

describe("current writer agrees with frozen artifacts", () => {
  test.each(
    listFrozenArtifactSets().filter(
      (set) => set.schemaVersion === DOCS_ARTIFACT_SCHEMA_VERSION,
    ),
  )("$name", async (set) => {
    const directory = join(recipesDirectory, set.name);
    const recipe = recipeSchema.parse(
      JSON.parse(readFileSync(join(directory, "recipe.json"), "utf8")),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(recipe.generatedAt));
    try {
      const bundle = await createRuntimeDocsArtifacts({
        siteId: recipe.siteId,
        versionId: recipe.versionId,
        projectSlug: recipe.projectSlug,
        projectName: recipe.projectName,
        siteConfig: recipe.siteConfig,
        features: recipe.features,
        navigation: recipe.navigation ?? null,
        pages: recipe.pages.map((page) => ({
          title: page.title,
          route: page.route,
          navigationPath: page.navigationPath,
          content: readFileSync(join(directory, page.file), "utf8"),
        })),
      });
      const objects = Object.fromEntries(
        bundle.files.map((file) => [
          `${set.artifactPrefix}/${file.path}`,
          file.content,
        ]),
      );
      expect(objects).toEqual(set.objects);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Freezes one artifact set from a recipe with the CURRENT writer.
 *
 * Usage:
 *   pnpm --filter @doxahq/docs-artifact-fixtures create-set <recipe-name>
 *
 * The recipe lives at `recipes/<recipe-name>/recipe.json` with its MDX pages
 * beside it. The output lands at `sets/schema-v{N}/<recipe-name>/`, where N
 * is the schema version the current writer stamps. The script refuses to
 * overwrite an existing set: a frozen set must never change. To capture a
 * new schema version, run the script again after the writer changes and
 * commit the new directory next to the old one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recipeSchema } from "./recipe";
import {
  DOCS_ARTIFACT_SCHEMA_VERSION,
  createRuntimeDocsArtifacts,
  type RuntimeDocsArtifactFile,
} from "@doxahq/docs-engine";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

async function main(): Promise<void> {
  const recipeName = process.argv[2];
  if (!recipeName) {
    throw new Error("Usage: create-set <recipe-name>");
  }

  const recipeDirectory = join(PACKAGE_ROOT, "recipes", recipeName);
  const recipe = recipeSchema.parse(
    JSON.parse(readFileSync(join(recipeDirectory, "recipe.json"), "utf8")),
  );

  const setDirectory = join(
    PACKAGE_ROOT,
    "sets",
    `schema-v${DOCS_ARTIFACT_SCHEMA_VERSION}`,
    recipeName,
  );
  if (existsSync(setDirectory)) {
    throw new Error(
      `${setDirectory} already exists. Frozen sets never change; delete it on purpose if you really mean to rebuild it.`,
    );
  }

  const bundle = await createRuntimeDocsArtifacts({
    siteId: recipe.siteId,
    versionId: recipe.versionId,
    projectSlug: recipe.projectSlug,
    projectName: recipe.projectName,
    pages: recipe.pages.map((page) => ({
      title: page.title,
      route: page.route,
      navigationPath: page.navigationPath,
      content: readFileSync(join(recipeDirectory, page.file), "utf8"),
    })),
    navigation: recipe.navigation ?? null,
    features: recipe.features,
    siteConfig: recipe.siteConfig,
  });

  const files = bundle.files.map((file) =>
    file.path === "manifest.json"
      ? withFixedGeneratedAt(file, recipe.generatedAt)
      : file,
  );
  for (const file of files) {
    writeText(join(setDirectory, "artifacts", file.path), file.content);
  }

  writeText(
    join(setDirectory, "set.json"),
    `${JSON.stringify(
      {
        name: recipeName,
        description: recipe.description,
        schemaVersion: DOCS_ARTIFACT_SCHEMA_VERSION,
        siteId: recipe.siteId,
        versionId: recipe.versionId,
        projectId: recipe.projectId,
        projectSlug: recipe.projectSlug,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Froze ${files.length} artifact files into ${setDirectory}`);
}

function withFixedGeneratedAt(
  manifestFile: RuntimeDocsArtifactFile,
  generatedAt: string,
): RuntimeDocsArtifactFile {
  const manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;
  return {
    ...manifestFile,
    content: `${JSON.stringify({ ...manifest, generatedAt }, null, 2)}\n`,
  };
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

await main();

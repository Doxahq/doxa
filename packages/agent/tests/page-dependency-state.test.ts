import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MemoryArtifactStore,
  createToolResultCache,
  createTrackedTools,
  executeTool,
  sha256Hex,
  type PageTarget,
} from "../src";
import { materializeWrittenPage } from "../src/doxa/artifact-materializer";
import { createPageDependencyState } from "../src/state/page-targets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("page dependency evidence", () => {
  test("records normalized tool access with structured page references", async () => {
    const project = await temporaryProject();
    const tracked = createTrackedTools(project, "read_only");

    await executeTool(
      tracked.tools,
      "Read",
      JSON.stringify({ path: "./src/client.ts" }),
    );
    await executeTool(
      tracked.tools,
      "Glob",
      JSON.stringify({ pattern: "src/**/*.ts" }),
    );

    const dependencies = createPageDependencyState(pageTarget(), {
      sourceFilesRead: tracked.getAccessedFiles(),
      sourceFilesDiscovered: tracked.getDiscoveredFiles(),
    });

    expect(dependencies).toEqual({
      sourceFilesRead: ["src/client.ts"],
      sourceFilesDiscovered: [
        "src/client.ts",
        "src/routes.ts",
      ],
      sourceEvidenceFiles: [
        "src/client.ts",
        "src/old-client.ts",
      ],
      referencedSymbols: ["createClient"],
      referencedRoutes: ["/sdk/client"],
    });
  });

  test("preserves dependency evidence when every tool result comes from cache", async () => {
    const project = await temporaryProject();
    const resultCache = createToolResultCache();
    const cachedSpans: Array<{ name: string; reused?: boolean }> = [];
    const uncachedPage = createTrackedTools(project, "read_only", {
      resultCache,
    });
    const cachedPage = createTrackedTools(project, "read_only", {
      resultCache,
    });
    const calls = [
      ["Read", { path: "./src/client.ts" }],
      ["Glob", { pattern: "src/**/*.ts" }],
      ["Grep", { pattern: "createClient", path: "src" }],
    ] as const;

    for (const [toolName, args] of calls) {
      await executeTool(uncachedPage.tools, toolName, JSON.stringify(args));
    }
    const missesAfterFirstPage = resultCache.misses;

    for (const [toolName, args] of calls) {
      await executeTool(cachedPage.tools, toolName, JSON.stringify(args), {
        onSpan: (span) => {
          cachedSpans.push(span);
        },
      });
    }

    expect(resultCache.misses).toBe(missesAfterFirstPage);
    expect(resultCache.hits).toBe(calls.length);
    expect(cachedPage.getAccessedFiles()).toEqual(
      uncachedPage.getAccessedFiles(),
    );
    expect(cachedPage.getDiscoveredFiles()).toEqual(
      uncachedPage.getDiscoveredFiles(),
    );
    expect(cachedPage.getAccessedFiles()).toEqual(["src/client.ts"]);
    expect(cachedPage.getDiscoveredFiles()).toEqual([
      "src/client.ts",
      "src/routes.ts",
    ]);
    expect(
      cachedSpans.map(({ name, reused }) => ({ name, reused })),
    ).toEqual([
      { name: "Read", reused: true },
      { name: "Glob", reused: true },
      { name: "Grep", reused: true },
    ]);
  });

  test("records bundled evidence as read when the writer does not call tools", () => {
    const dependencies = createPageDependencyState(pageTarget(), {
      evidenceBundlePaths: [
        "./src/bundled.ts",
        "src/client.ts",
        "../outside.ts",
      ],
    });

    expect(dependencies.sourceFilesRead).toEqual([
      "src/bundled.ts",
      "src/client.ts",
    ]);
  });

  test("returns content integrity with dependency evidence", async () => {
    const artifacts = new MemoryArtifactStore();
    const target = pageTarget();
    const content = "# Client\n";

    const materialized = await materializeWrittenPage({
      artifacts,
      target,
      writerResult: {
        content,
        sourceFilesRead: [
          "src/routes.ts",
          "src/client.ts",
          "src/routes.ts",
        ],
        sourceFilesDiscovered: [
          "src\\client.ts",
          "../outside.ts",
        ],
      },
      pageInputHash: "a".repeat(64),
    });

    expect(materialized.page.contentHash).toBe(await sha256Hex(content));
    expect(materialized.page.pageInputHash).toBe("a".repeat(64));
    expect(materialized.page.dependencies).toEqual(
      materialized.cacheEntry.dependencies,
    );
    expect(materialized.page.dependencies.sourceFilesRead).toEqual([
      "src/client.ts",
      "src/routes.ts",
    ]);
    expect(materialized.page.dependencies.sourceFilesDiscovered).toEqual([
      "src/client.ts",
    ]);
    await expect(
      artifacts.readText(target.outputPath),
    ).resolves.toBe(content);
  });
});

function pageTarget(): PageTarget {
  return {
    pageId: "client",
    title: "Client",
    sectionTitle: "SDK",
    outputPath: "sdk/client/index.mdx",
    description: "Create a client.",
    sourceEvidence: [
      { path: "src/client.ts" },
      { path: "src/old-client.ts" },
      { path: "src/client.ts" },
    ],
    canonicalRoute: "/sdk/client",
    reference: {
      kind: "sdk",
      exportId: "create-client",
      exportName: "createClient",
      exportKind: "function",
    },
  };
}

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "doxa-dependencies-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, "src", "client.ts"),
      "export function createClient() {}\n",
    ),
    writeFile(
      join(directory, "src", "routes.ts"),
      "export const route = '/sdk/client';\n",
    ),
  ]);
  return directory;
}

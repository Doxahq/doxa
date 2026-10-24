import {
  GENERATION_STATE_SCHEMA_VERSION,
  incrementalGenerationPlanSchema,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import { pageBriefFingerprints, pageSourcesOf } from "../src/review-evidence";
import { frontmatterDescription, loadSeedSite } from "../src/seed-site";

const prefix = "sites/site-1/versions/editor-1";

function files(entries: Record<string, unknown>): (key: string) => Promise<string | null> {
  const map = new Map(
    Object.entries(entries).map(([path, value]) => [
      `${prefix}/${path}`,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  return async (key) => map.get(key) ?? null;
}

describe("loadSeedSite", () => {
  test("reads the navigation, the page metadata, and the bodies", async () => {
    const read = files({
      "manifest.json": {
        siteId: "site-1",
        versionId: "editor-1",
        projectSlug: "example",
        generatedAt: "2026-10-11T00:00:00.000Z",
        pages: [
          { title: "Intro", href: "/", sourcePath: "source/index.mdx" },
          { title: "Install", href: "/install", sourcePath: "source/install/index.mdx" },
          { title: "Questions", href: "/faq/questions", sourcePath: "source/faq/questions/index.mdx" },
        ],
      },
      "settings/sections.json": [
        { slug: "default", label: "Docs", default: true },
        { slug: "faq", label: "FAQ" },
      ],
      "settings/documents.json": [
        { title: "Intro", href: "/" },
        { heading: "Guides", items: [{ title: "Install", href: "/install" }] },
      ],
      "settings/documents.faq.json": [{ title: "Questions", href: "/faq/questions" }],
      "source/index.mdx": "---\ntitle: Intro\n---\n\n# Intro\n",
      "source/install/index.mdx": "---\ntitle: Install\ndescription: \"Set it up\"\n---\n\nRun it.\n",
      "source/faq/questions/index.mdx": "# Questions\n",
    });

    const seed = await loadSeedSite(read, prefix);

    expect(seed.site.sections).toEqual([
      {
        slug: "default",
        label: "Docs",
        isDefault: true,
        nodes: [
          { title: "Intro", href: "/" },
          { heading: "Guides" },
          { title: "Install", href: "/install" },
        ],
      },
      {
        slug: "faq",
        label: "FAQ",
        isDefault: false,
        nodes: [{ title: "Questions", href: "/faq/questions" }],
      },
    ]);
    expect(seed.site.pages).toEqual([
      { href: "/", title: "Intro" },
      { href: "/install", title: "Install", description: "Set it up" },
      { href: "/faq/questions", title: "Questions" },
    ]);
    expect(Object.keys(seed.bodies)).toEqual(["/", "/install", "/faq/questions"]);
  });

  test("rejects a version without a manifest", async () => {
    await expect(loadSeedSite(files({}), prefix)).rejects.toThrow(
      "The seed version has no valid manifest.",
    );
  });

  test("reads only a plain frontmatter description", () => {
    expect(frontmatterDescription("---\ndescription: 'Quick start'\n---\n")).toBe("Quick start");
    expect(frontmatterDescription("---\ntitle: A\n---\n")).toBeNull();
    expect(frontmatterDescription("# No frontmatter\n")).toBeNull();
  });
});

describe("pageSourcesOf", () => {
  test("cites the files behind each written page only", () => {
    const plan = incrementalGenerationPlanSchema.parse({
      analysisMode: "incremental",
      structureMode: "reuse",
      regeneratePageIds: ["auth"],
      reusePageIds: ["faq"],
      removedPageIds: [],
      modelCallsRequired: true,
      reasons: ["Page auth changed."],
    });
    const state = (pageId: string, route: string, read: string[]) => ({
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      pageId,
      title: pageId,
      route,
      navigationPath: `default/${pageId}.md`,
      artifactKey: `${prefix}/source${route}/index.mdx`,
      contentHash: "a".repeat(64),
      pageInputHash: "a".repeat(64),
      dependencies: {
        sourceFilesRead: read,
        sourceFilesDiscovered: [],
        sourceEvidenceFiles: ["README.md"],
        referencedSymbols: [],
        referencedRoutes: [],
      },
    });

    expect(
      pageSourcesOf(plan, [
        state("auth", "/auth", ["src/auth.ts", "README.md"]),
        state("faq", "/faq", ["src/faq.ts"]),
      ]),
    ).toEqual([{ href: "/auth", paths: ["src/auth.ts", "README.md"] }]);
  });
});

describe("pageBriefFingerprints", () => {
  test("gives written pages this run's brief and reused pages their earlier one", () => {
    const plan = incrementalGenerationPlanSchema.parse({
      analysisMode: "incremental",
      structureMode: "reuse",
      regeneratePageIds: ["auth"],
      reusePageIds: ["faq", "legacy"],
      removedPageIds: [],
      modelCallsRequired: true,
      reasons: ["Page auth changed."],
    });
    const previous = (pageId: string, briefFingerprint?: string) => ({
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      pageId,
      title: pageId,
      route: `/${pageId}`,
      navigationPath: `default/${pageId}.md`,
      artifactKey: `${prefix}/source/${pageId}/index.mdx`,
      contentHash: "a".repeat(64),
      pageInputHash: "a".repeat(64),
      dependencies: {
        sourceFilesRead: [],
        sourceFilesDiscovered: [],
        sourceEvidenceFiles: [],
        referencedSymbols: [],
        referencedRoutes: [],
      },
      ...(briefFingerprint ? { briefFingerprint } : {}),
    });

    const briefOf = pageBriefFingerprints({
      plan,
      runBriefFingerprint: "brief-v2",
      previousPages: [previous("auth", "brief-v1"), previous("faq", "brief-v1"), previous("legacy")],
    });

    expect(briefOf("auth")).toBe("brief-v2");
    expect(briefOf("faq")).toBe("brief-v1");
    expect(briefOf("legacy")).toBeUndefined();
  });
});

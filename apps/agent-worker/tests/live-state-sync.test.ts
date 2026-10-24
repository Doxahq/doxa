import {
  buildPageInputHashMap,
  flattenStructure,
  isDocumentationStructure,
  stablePageId,
  type DocumentationStructure,
} from "@doxahq/agent";
import {
  emptyPageDependencyState,
  GENERATION_STATE_SCHEMA_VERSION,
  type GenerationPageState,
  type ReusableGenerationState,
} from "@doxahq/contracts";
import { relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import { sourcePathForHref } from "@doxahq/docs-engine";
import { describe, expect, test } from "vitest";

import { syncReusableStateWithLive } from "../src/live-state-sync";
import { loadSiteNavigation } from "../src/seed-site";

const LIVE_PREFIX = "sites/site-1/versions/live-1";
const STATE_PREFIX = "sites/site-1/versions/generated-1";
const HASH = "a".repeat(64);

/** The structure that the last generation wrote. */
const STORED: DocumentationStructure = {
  sections: [
    {
      id: "getting-started",
      title: "Getting Started",
      default: true,
      pages: [
        { id: "install", title: "Install", description: "Install FlagForge.", sourceEvidence: [{ path: "src/install.ts" }] },
        { id: "overview02", title: "Overview01", description: "What FlagForge is.", sourceEvidence: [{ path: "README.md" }] },
      ],
    },
    {
      id: "guides",
      title: "Guides",
      pages: [
        { id: "flags", title: "Flags", description: "Use flags.", group: "Basics", sourceEvidence: [{ path: "src/flags.ts" }] },
        { id: "rollouts", title: "Rollouts", description: "Roll out a flag.", sourceEvidence: [{ path: "src/rollouts.ts" }] },
      ],
    },
  ],
};

const BODIES: Record<string, string> = {
  "/install": "Run the installer.",
  "/overview02": "FlagForge serves feature flags.",
  "/guides/flags": "Create a flag.",
  "/guides/rollouts": "Roll a flag out in steps.",
};

type NavigationNode = { title: string; href: string } | { heading: string } | { spacer: true };

interface LiveSite {
  default: NavigationNode[];
  guides: NavigationNode[];
  /** Page titles and bodies by route, when they differ from the navigation and BODIES. */
  pages?: Record<string, { title: string; body: string }>;
  /** Pages that the manifest lists and no navigation does. */
  unlisted?: Record<string, { title: string; body: string }>;
  /** The label of the default section, "Getting Started" unless set. */
  defaultLabel?: string;
}

/** The live site as the last generation published it. */
function untouched(): LiveSite {
  return {
    default: [
      { title: "Install", href: "/install" },
      { title: "Overview01", href: "/overview02" },
    ],
    guides: [
      { heading: "Basics" },
      { title: "Flags", href: "/guides/flags" },
      { spacer: true },
      { heading: "Other" },
      { title: "Rollouts", href: "/guides/rollouts" },
    ],
  };
}

/** The route of a stored page file: `default/install.md` is `/install`, `guides/flags.md` is `/guides/flags`. */
function routeOfPath(path: string): string {
  return `/${path.replace(/^default\//, "").replace(/\.md$/, "")}`;
}

function storedState(hashes: Record<string, string> = buildPageInputHashMap(STORED)): ReusableGenerationState {
  const pages = flattenStructure(STORED).map((target): GenerationPageState => {
    const pageId = stablePageId(target);
    return {
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      pageId,
      title: target.page.title,
      route: routeOfPath(target.path),
      navigationPath: target.path,
      artifactKey: `${STATE_PREFIX}/${target.path}`,
      contentHash: HASH,
      pageInputHash: hashes[pageId] ?? HASH,
      dependencies: { ...emptyPageDependencyState(), sourceEvidenceFiles: [`${target.page.sourceEvidence?.[0]?.path}`] },
    };
  });
  return {
    manifest: {
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      siteId: "site-1",
      versionId: "generated-1",
      baselineVersionId: null,
      generatorFingerprint: "doxabot-v1",
      sourceRevision: "1".repeat(40),
      sourceTreeHash: "2".repeat(40),
      source: { key: "source.json", hash: HASH },
      analysis: { key: "analysis.json", hash: HASH },
      structure: { key: "structure.json", hash: HASH },
      pages: [],
      createdAt: "2026-10-17T00:00:00.000Z",
    },
    source: { schemaVersion: GENERATION_STATE_SCHEMA_VERSION, sourceRevision: "1".repeat(40), sourceTreeHash: "2".repeat(40), files: [] },
    analysis: { schemaVersion: GENERATION_STATE_SCHEMA_VERSION, analysis: {}, analysisHash: HASH, sourceSummaries: [] },
    structure: { schemaVersion: GENERATION_STATE_SCHEMA_VERSION, structure: JSON.parse(JSON.stringify(STORED)), structureHash: HASH, structuralFingerprint: HASH },
    pages,
  };
}

/** The files of one version of the site, by key under `prefix`. */
function versionFiles(prefix: string, site: LiveSite): Map<string, string> {
  const files = new Map<string, string>();
  const put = (path: string, value: unknown) =>
    files.set(`${prefix}/${path}`, typeof value === "string" ? value : JSON.stringify(value));
  const listed = [...site.default, ...site.guides].flatMap((node) => ("href" in node ? [node] : []));
  const pages = [
    ...listed.map((node) => ({
      href: node.href,
      title: site.pages?.[node.href]?.title ?? node.title,
      body: site.pages?.[node.href]?.body ?? BODIES[node.href] ?? "",
    })),
    ...Object.entries(site.unlisted ?? {}).map(([href, page]) => ({ href, ...page })),
  ];

  put("manifest.json", {
    siteId: "site-1",
    versionId: prefix.split("/").at(-1),
    projectSlug: "flagforge",
    generatedAt: "2026-10-17T00:00:00.000Z",
    pages: pages.map(({ href, title }) => ({ title, href, sourcePath: sourcePathForHref(href) })),
  });
  put("settings/sections.json", [
    { slug: "default", label: site.defaultLabel ?? "Getting Started", default: true },
    { slug: "guides", label: "Guides" },
  ]);
  put(relativeNavigationPathForSection("default"), site.default);
  put(relativeNavigationPathForSection("guides"), site.guides);
  for (const page of pages) put(sourcePathForHref(page.href), `---\ntitle: ${page.title}\n---\n\n${page.body}\n`);
  return files;
}

/** The live version, the generated version (the stored page artifacts), by key. */
function objects(live: LiveSite, generated: LiveSite = untouched()): Map<string, string> {
  const files = new Map([...versionFiles(LIVE_PREFIX, live), ...versionFiles(STATE_PREFIX, generated)]);
  for (const target of flattenStructure(STORED)) {
    files.set(`${STATE_PREFIX}/${target.path}`, `---\ntitle: ${target.page.title}\n---\n\n${BODIES[routeOfPath(target.path)]}\n`);
  }
  return files;
}

/**
 * Syncs the stored state with the `live` site. The generation published
 * `generated`, the untouched site unless a test says otherwise; null stands
 * for a generated version whose files are gone.
 */
async function sync(site: LiveSite, state = storedState(), generated: LiveSite | null = untouched()) {
  const files = objects(site, generated ?? untouched());
  const read = async (key: string) => files.get(key) ?? null;
  return syncReusableStateWithLive({
    state,
    live: await loadSiteNavigation(read, LIVE_PREFIX, "live version"),
    generated: generated ? await loadSiteNavigation(read, STATE_PREFIX) : null,
    liveArtifactPrefix: LIVE_PREFIX,
    readers: {
      readLive: (path) => read(`${LIVE_PREFIX}/${path}`),
      readArtifact: read,
      hashContent: async (content) => `sha:${content.length}`,
    },
  });
}

function structureOf(state: ReusableGenerationState): DocumentationStructure {
  const structure = state.structure.structure;
  if (!isDocumentationStructure(structure)) throw new Error("The synced state has no structure.");
  return structure;
}

function recordAt(state: ReusableGenerationState, route: string): GenerationPageState {
  const record = state.pages.find((page) => page.route === route);
  if (!record) throw new Error(`No record at ${route}.`);
  return record;
}

/** Whether the run would write the page again: its stored hash differs from the synced structure's. */
function needsRewrite(state: ReusableGenerationState, pageId: string): boolean {
  const record = state.pages.find((page) => page.pageId === pageId);
  return record?.pageInputHash !== buildPageInputHashMap(structureOf(state))[pageId];
}

describe("syncReusableStateWithLive", () => {
  test("keeps the stored state when the live site is as the generation published it", async () => {
    const state = storedState();

    const result = await sync(untouched(), state);

    expect(result.state).toBe(state);
    expect(result.summary).toEqual({ moved: 0, retitled: 0, removed: 0, added: 0 });
  });

  test("does not rename a page whose navigation label differs from its title", async () => {
    const site = untouched();
    site.guides[1] = { title: "Flag basics", href: "/guides/flags" };
    site.pages = { "/guides/flags": { title: "Flags", body: BODIES["/guides/flags"] ?? "" } };
    const state = storedState();

    expect((await sync(site, state)).state).toBe(state);
  });

  test("follows a page that a person renamed and moved, and does not write it again", async () => {
    const site = untouched();
    site.default[1] = { title: "Overview", href: "/overview" };
    site.pages = { "/overview": { title: "Overview", body: BODIES["/overview02"] ?? "" } };

    const { state, summary } = await sync(site);

    const record = recordAt(state, "/overview");
    expect(record).toMatchObject({
      pageId: "getting-started/overview02",
      title: "Overview",
      navigationPath: "default/overview.md",
      artifactKey: `${LIVE_PREFIX}/${sourcePathForHref("/overview")}`,
      dependencies: { sourceEvidenceFiles: ["README.md"] },
    });
    expect(state.pages.some((page) => page.route === "/overview02")).toBe(false);
    expect(structureOf(state).sections[0]?.pages[1]).toEqual({
      id: "overview02",
      title: "Overview",
      description: "What FlagForge is.",
      sourceEvidence: [{ path: "README.md" }],
      canonicalRoute: "/overview",
    });
    expect(needsRewrite(state, record.pageId)).toBe(false);
    expect(summary).toEqual({ moved: 1, retitled: 0, removed: 0, added: 0 });
  });

  test("takes a new title and group at the same route without writing the page again", async () => {
    const site = untouched();
    site.guides = [
      { heading: "Advanced" },
      { title: "Feature flags", href: "/guides/flags" },
      { title: "Rollouts", href: "/guides/rollouts" },
    ];

    const { state, summary } = await sync(site);

    expect(structureOf(state).sections[1]?.pages[0]).toMatchObject({ id: "flags", title: "Feature flags", group: "Advanced" });
    expect(structureOf(state).sections[1]?.pages[1]).toMatchObject({ id: "rollouts", group: "Advanced" });
    expect(recordAt(state, "/guides/flags").title).toBe("Feature flags");
    expect(needsRewrite(state, "guides/flags")).toBe(false);
    expect(summary).toEqual({ moved: 0, retitled: 1, removed: 0, added: 0 });
  });

  test("drops a page that a person deleted", async () => {
    const site = untouched();
    site.guides = site.guides.filter((node) => !("href" in node && node.href === "/guides/rollouts"));

    const { state, summary } = await sync(site);

    expect(state.pages.map((page) => page.pageId)).toEqual([
      "getting-started/install",
      "getting-started/overview02",
      "guides/flags",
    ]);
    expect(summary.removed).toBe(1);
  });

  test("keeps a page that a person created, from its live file, with nothing to write it from", async () => {
    const site = untouched();
    site.guides.push({ title: "Limits", href: "/guides/limits" });
    site.pages = { "/guides/limits": { title: "Limits", body: "Plans have limits." } };

    const { state, summary } = await sync(site);

    expect(recordAt(state, "/guides/limits")).toMatchObject({
      pageId: "guides/limits",
      artifactKey: `${LIVE_PREFIX}/${sourcePathForHref("/guides/limits")}`,
      dependencies: emptyPageDependencyState(),
    });
    expect(structureOf(state).sections[1]?.pages.at(-1)).toEqual({ id: "limits", title: "Limits", description: "Limits" });
    expect(needsRewrite(state, "guides/limits")).toBe(false);
    expect(summary).toEqual({ moved: 0, retitled: 0, removed: 0, added: 1 });
  });

  test("hides a page that a person took out of the navigation, in its own section", async () => {
    const site = untouched();
    site.guides = [{ heading: "Basics" }, { title: "Flags", href: "/guides/flags" }];
    site.unlisted = { "/guides/rollouts": { title: "Rollouts", body: BODIES["/guides/rollouts"] ?? "" } };

    const { state } = await sync(site);

    expect(structureOf(state).sections[1]?.pages.map((page) => [page.id, page.navVisibility])).toEqual([
      ["flags", undefined],
      ["rollouts", "hidden"],
    ]);
    expect(recordAt(state, "/guides/rollouts").pageId).toBe("guides/rollouts");
  });

  test("keeps a stored hash that the stored structure does not explain, so the page is written again", async () => {
    const site = untouched();
    site.default[1] = { title: "Overview", href: "/overview" };
    site.pages = { "/overview": { title: "Overview", body: BODIES["/overview02"] ?? "" } };
    const stale = { ...buildPageInputHashMap(STORED), "getting-started/overview02": "b".repeat(64) };

    const { state } = await sync(site, storedState(stale));

    expect(recordAt(state, "/overview").pageInputHash).toBe("b".repeat(64));
    expect(needsRewrite(state, "getting-started/overview02")).toBe(true);
  });

  test("keeps a heading that the generation derived out of the stored structure", async () => {
    const derived = untouched();
    derived.guides = [
      { heading: "Basics" },
      { title: "Flags", href: "/guides/flags" },
      { heading: "Reference" },
      { title: "Rollouts", href: "/guides/rollouts" },
    ];
    const state = storedState();

    expect((await sync(derived, state, derived)).state).toBe(state);
  });

  test("keeps the stored order where a person did not reorder the pages", async () => {
    const published = untouched();
    published.guides = [{ title: "Rollouts", href: "/guides/rollouts" }, { title: "Flags", href: "/guides/flags" }];
    const site = { ...published, defaultLabel: "Start here" };

    const { state } = await sync(site, storedState(), published);

    expect(structureOf(state).sections[1]?.pages.map((page) => page.id)).toEqual(["flags", "rollouts"]);
    expect(structureOf(state).sections[0]?.title).toBe("Start here");
  });

  test("follows a person's new order of the pages", async () => {
    const site = untouched();
    site.guides = [{ title: "Rollouts", href: "/guides/rollouts" }, { heading: "Basics" }, { title: "Flags", href: "/guides/flags" }];

    const { state } = await sync(site);

    expect(structureOf(state).sections[1]?.pages.map((page) => [page.id, page.group])).toEqual([
      ["rollouts", undefined],
      ["flags", "Basics"],
    ]);
    expect(needsRewrite(state, "guides/rollouts")).toBe(false);
  });

  test("follows titles and routes, and keeps placements, when the generated version is gone", async () => {
    const site = untouched();
    site.default[1] = { title: "Overview", href: "/overview" };
    site.pages = { "/overview": { title: "Overview", body: BODIES["/overview02"] ?? "" } };
    site.guides = [{ title: "Flags", href: "/guides/flags" }, { title: "Rollouts", href: "/guides/rollouts" }];

    const { state } = await sync(site, storedState(), null);

    expect(recordAt(state, "/overview").title).toBe("Overview");
    expect(structureOf(state).sections[1]?.pages[0]).toMatchObject({ id: "flags", group: "Basics" });
  });

  test("stops when a live page cannot be read", async () => {
    const site = untouched();
    site.guides.push({ title: "Limits", href: "/guides/limits" });
    const files = objects(site);
    files.delete(`${LIVE_PREFIX}/${sourcePathForHref("/guides/limits")}`);
    const read = async (key: string) => files.get(key) ?? null;

    await expect(syncReusableStateWithLive({
      state: storedState(),
      live: await loadSiteNavigation(read, LIVE_PREFIX),
      generated: await loadSiteNavigation(read, STATE_PREFIX),
      liveArtifactPrefix: LIVE_PREFIX,
      readers: { readLive: (path) => read(`${LIVE_PREFIX}/${path}`), readArtifact: read, hashContent: async () => HASH },
    })).rejects.toThrow("The live page /guides/limits could not be read.");
  });
});

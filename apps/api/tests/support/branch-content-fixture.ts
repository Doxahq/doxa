import {
  branchIdSchema,
  siteIdSchema,
  versionIdSchema,
} from "@doxahq/contracts/docs-branches";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import type { StoredBranchChange } from "../../src/repositories/docs-branches";
import { InMemoryDocsBranchStore } from "./in-memory-docs-branches";
import {
  createInMemoryDocsContentStore,
  type InMemoryObjects,
} from "./in-memory-docs-content-store";

export const USER_ID = "user-1";
export const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
export const SITE_ID = "10000000-0000-4000-8000-000000000002";
export const BASE_VERSION_ID = "10000000-0000-4000-8000-000000000003";
export const NEXT_VERSION_ID = "10000000-0000-4000-8000-000000000004";
export const BRANCH_ID = "10000000-0000-4000-8000-000000000005";
export const BASE_PREFIX = buildArtifactPrefix(SITE_ID, BASE_VERSION_ID);

/** The pages of the base version: href, manifest title, and MDX source. */
export const BASE_PAGES = [
  { href: "/", title: "Home", source: "---\ntitle: Home\n---\n\n# Welcome\n" },
  {
    href: "/install",
    title: "Install",
    source: "---\ntitle: Install\n---\n\n# Install\n\nRun the setup script.\n",
  },
  {
    href: "/legacy",
    title: "Legacy",
    source: "---\ntitle: Legacy\n---\n\n# Legacy\n\nThe old billing flow.\n",
  },
] as const;

export function sourcePathOf(href: string): string {
  return href === "/" ? "source/index.mdx" : `source${href}/index.mdx`;
}

function manifest(pages: ReadonlyArray<{ href: string; title: string }>) {
  return JSON.stringify({
    siteId: SITE_ID,
    versionId: BASE_VERSION_ID,
    projectSlug: "example",
    generatedAt: "2026-10-05T00:00:00.000Z",
    pages: pages.map((page) => ({
      href: page.href,
      title: page.title,
      sourcePath: sourcePathOf(page.href),
    })),
  });
}

/**
 * A site whose main is the base version, with one named branch on it. The
 * branch starts with no changes; `setChanges` gives it some.
 */
export function createBranchContentFixture() {
  const objects: InMemoryObjects = new Map<string, string | Uint8Array>([
    [`${BASE_PREFIX}/manifest.json`, manifest(BASE_PAGES)],
    [`${BASE_PREFIX}/settings/site.json`, JSON.stringify({ name: "Example" })],
    [
      `${BASE_PREFIX}/settings/documents.json`,
      JSON.stringify(BASE_PAGES.map(({ href, title }) => ({ href, title }))),
    ],
    ...BASE_PAGES.map(
      (page): [string, string] => [
        `${BASE_PREFIX}/${sourcePathOf(page.href)}`,
        page.source,
      ],
    ),
  ]);
  const store = createInMemoryDocsContentStore(objects);
  const branches = new InMemoryDocsBranchStore();
  branches.addSite(USER_ID, {
    id: siteIdSchema.parse(SITE_ID),
    projectId: PROJECT_ID,
    projectName: "Example",
    projectSlug: "example",
    mainVersionId: versionIdSchema.parse(BASE_VERSION_ID),
    mainVersionNumber: 1,
    mainArtifactPrefix: BASE_PREFIX,
    mainCreatedAt: new Date("2026-10-05T00:00:00.000Z"),
  });
  const now = new Date("2026-10-05T00:00:00.000Z");
  branches.addBranch({
    id: branchIdSchema.parse(BRANCH_ID),
    siteId: siteIdSchema.parse(SITE_ID),
    kind: "named",
    purpose: "user",
    name: "agent-docs",
    ownerUserId: USER_ID,
    baseVersionId: versionIdSchema.parse(BASE_VERSION_ID),
    createdFromBranchId: null,
    createdBy: { kind: "user" },
    revision: 1,
    previewRevision: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    objects,
    store,
    branches,
    scope: { userId: USER_ID, projectId: PROJECT_ID, branch: BRANCH_ID },
    setChanges(changes: ReadonlyArray<BranchChangeSpec>) {
      branches.setChanges(BRANCH_ID, changes.map(toStoredChange));
    },
    manifestWith(pages: ReadonlyArray<{ href: string; title: string }>) {
      return manifest(pages);
    },
  };
}

/** A branch change: new content for a path, or null to delete it. */
export interface BranchChangeSpec {
  path: string;
  content: string | null;
}

export function toStoredChange(spec: BranchChangeSpec): StoredBranchChange {
  const common = {
    branchId: branchIdSchema.parse(BRANCH_ID),
    path: spec.path,
    updatedByUserId: USER_ID,
    origin: "mcp" as const,
    updatedAt: new Date("2026-10-05T01:00:00.000Z"),
  };
  return spec.content === null
    ? { ...common, kind: "delete", content: null, contentSha256: null, byteSize: 0 }
    : {
        ...common,
        kind: "upsert",
        content: spec.content,
        contentSha256: `sha-${spec.path}`,
        byteSize: new TextEncoder().encode(spec.content).byteLength,
      };
}

import { describe, expect, test } from "vitest";
import {
  createRuntimeDocsArtifacts,
  createRuntimeSearchDocument,
  compiledSearchIndexPathForPrefix,
  docsManifestSchema,
  generationStateOwnerVersionId,
  hrefForSourcePath,
  normalizeHref,
  sourcePathForHref,
} from "../src/index";

test("builds one search document for a page without an existing index entry", () => {
  const document = createRuntimeSearchDocument({
    title: "New Page",
    route: "/new-page",
    content:
      "---\ntitle: New Page\ndescription: A new page\n---\n\n# New Page\n\nNew Page!\n",
  });

  expect(document).toMatchObject({
    id: "/new-page",
    slug: "/new-page",
    title: "New Page",
    description: "A new page",
    section: "default",
  });
  expect(document.content).toContain("New Page!");
});

describe("normalizeHref", () => {
  test.each([
    ["", "/"],
    ["/", "/"],
    ["getting-started.mdx", "/getting-started"],
    ["docs\\install\\index.md", "/docs/install"],
    ["/guides/configuration.tsx", "/guides/configuration"],
    ["///nested/path///", "/nested/path"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeHref(input)).toBe(expected);
  });
});

describe("sourcePathForHref", () => {
  test.each([
    ["/", "source/index.mdx"],
    ["/getting-started", "source/getting-started/index.mdx"],
    ["/guides/configuration/", "source/guides/configuration/index.mdx"],
  ])("maps %s to %s", (href, expected) => {
    expect(sourcePathForHref(href)).toBe(expected);
  });
});

describe("hrefForSourcePath", () => {
  test.each([
    ["source/index.mdx", "/"],
    ["source/getting-started/index.mdx", "/getting-started"],
    ["source/guides/configuration/index.mdx", "/guides/configuration"],
    ["manifest.json", null],
    ["source/notes.mdx", null],
  ])("maps %s to %s", (path, expected) => {
    expect(hrefForSourcePath(path)).toBe(expected);
  });
});

describe("generationStateOwnerVersionId", () => {
  test.each([
    ["sites/site-1/generation-state/version-2", "version-2"],
    ["sites/site-1/content-versions/version-2", null],
    ["sites/site-2/generation-state/version-2", null],
    ["sites/site-1/generation-state/version-2/extra", null],
  ])("reads the owner of %s", (prefix, expected) => {
    expect(generationStateOwnerVersionId("site-1", prefix)).toBe(expected);
  });
});

describe("createRuntimeDocsArtifacts", () => {
  test("writes a prebuilt search index for server-side search", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [
        {
          title: "Overview",
          route: "/",
          content:
            "---\ntitle: Overview\n---\n\n# Overview\n\nSearchable docs.",
        },
      ],
    });

    const compiled = JSON.parse(
      fileContent(bundle.files, "search/minisearch.json"),
    ) as { contentVersion?: string; serializedIndex?: string };

    expect(compiled.contentVersion).toBe("version-1");
    expect(compiled.serializedIndex).toContain("Searchable docs");
    expect(
      compiledSearchIndexPathForPrefix("sites/site-1/versions/version-1"),
    ).toBe("sites/site-1/versions/version-1/search/minisearch.json");
  });

  test("compiles generated navigation into section-specific runtime settings", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [
        {
          title: "Overview",
          route: "/",
          navigationPath: "default/overview.md",
          content: "---\ntitle: Overview\n---\n\n# Overview",
        },
        {
          title: "Quickstart Guide",
          route: "/quickstart",
          navigationPath: "default/quickstart.md",
          content: "---\ntitle: Quickstart Guide\n---\n\n# Quickstart",
        },
        {
          title: "Health Endpoint",
          route: "/rest-api/health",
          navigationPath: "rest-api/health.md",
          content: "---\ntitle: Health Endpoint\n---\n\n# Health",
        },
        {
          title: "Local Development Setup",
          route: "/development/setup",
          navigationPath: "development/setup.md",
          content: "---\ntitle: Local Development Setup\n---\n\n# Setup",
        },
      ],
      navigation: {
        sections: [
          {
            slug: "default",
            items: ["default/overview.md", "default/quickstart.md"],
            groups: [
              { heading: "Start Here", items: ["default/overview.md"] },
              { heading: "Guides", items: ["default/quickstart.md"] },
            ],
          },
          {
            slug: "rest-api",
            items: ["rest-api/health.md"],
            groups: [{ heading: "Status", items: ["rest-api/health.md"] }],
          },
          {
            slug: "development",
            items: ["development/setup.md"],
            groups: [
              { heading: "Contribute", items: ["development/setup.md"] },
            ],
          },
        ],
        icons: {
          "default/overview.md": "compass",
          "default/quickstart.md": "rocket",
          "development/setup.md": "wrench",
        },
        navTitles: {
          "default/overview.md": "Overview",
          "default/quickstart.md": "Quickstart",
          "rest-api/health.md": "Health",
          "development/setup.md": "Local Setup",
        },
        navBadges: {
          "rest-api/health.md": "GET",
        },
        sectionMetadata: {
          default: {
            label: "Documentation",
            kind: "documentation",
            layout: "docs",
          },
          "rest-api": {
            label: "REST API",
            kind: "reference",
            layout: "reference",
          },
          development: {
            label: "Development",
            kind: "development",
            layout: "docs",
          },
        },
      },
    });

    expect(
      JSON.parse(fileContent(bundle.files, "settings/sections.json")),
    ).toEqual([
      {
        slug: "default",
        label: "Documentation",
        default: true,
        kind: "documentation",
        layout: "docs",
      },
      {
        slug: "rest-api",
        label: "REST API",
        kind: "reference",
        layout: "reference",
      },
      {
        slug: "development",
        label: "Development",
        kind: "development",
        layout: "docs",
      },
    ]);
    expect(
      JSON.parse(fileContent(bundle.files, "settings/documents.json")),
    ).toEqual([
      { heading: "Start Here" },
      { title: "Overview", href: "/", icon: "compass" },
      { spacer: true },
      { heading: "Guides" },
      { title: "Quickstart", href: "/quickstart", icon: "rocket" },
    ]);
    expect(
      JSON.parse(fileContent(bundle.files, "settings/documents.rest-api.json")),
    ).toEqual([
      { heading: "Status" },
      { title: "Health", href: "/rest-api/health", badge: "GET" },
    ]);
    expect(
      JSON.parse(
        fileContent(bundle.files, "settings/documents.development.json"),
      ),
    ).toEqual([
      { heading: "Contribute" },
      { title: "Local Setup", href: "/development/setup", icon: "wrench" },
    ]);
  });

  test("uses the first generated navigation page without creating a synthetic root", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [
        {
          title: "Overview",
          route: "/overview",
          navigationPath: "default/overview.md",
          content: "---\ntitle: Overview\n---\n\n# Overview",
        },
      ],
      navigation: {
        sections: [
          {
            slug: "default",
            items: ["default/overview.md"],
            groups: [{ heading: "Start Here", items: ["default/overview.md"] }],
          },
        ],
      },
    });

    expect(bundle.manifest.pages.map((page) => page.href)).toEqual([
      "/overview",
    ]);
    expect(
      JSON.parse(fileContent(bundle.files, "settings/documents.json")),
    ).toEqual([
      { heading: "Start Here" },
      { title: "Overview", href: "/overview" },
    ]);
  });

  test("does not add a placeholder root page when generated docs do not include one", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [
        {
          title: "Install",
          route: "guides/install.mdx",
          content: "---\ntitle: Install\n---\n\n# Install\n\nUse pnpm.",
        },
      ],
    });

    expect(bundle.manifest.pages.map((page) => page.href)).toEqual([
      "/guides/install",
    ]);
    expect(bundle.files.map((file) => file.path)).toEqual([
      "source/guides/install/index.mdx",
      "settings/documents.json",
      "settings/sections.json",
      "settings/site.json",
      "search/index.json",
      "search/minisearch.json",
      "manifest.json",
    ]);
    expect(
      docsManifestSchema.safeParse(
        JSON.parse(fileContent(bundle.files, "manifest.json")),
      ).success,
    ).toBe(true);
  });

  test("writes the project playground feature setting", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [],
      features: { apiPlayground: false },
    });

    expect(
      JSON.parse(fileContent(bundle.files, "settings/site.json")).features,
    ).toMatchObject({
      apiPlayground: false,
    });
  });

  test("preserves an existing overview page and keeps settings/search in sync", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [
        {
          title: "Overview",
          route: "/index.mdx",
          content:
            "---\ntitle: Overview\n---\n\n# Overview\n\nDoxa platform docs.",
        },
        {
          title: "API",
          route: "/reference/api",
          content: "# API\n\nUse `fetch`.",
        },
      ],
    });

    expect(bundle.manifest.pages.map((page) => page.href)).toEqual([
      "/",
      "/reference/api",
    ]);

    const documents = JSON.parse(
      fileContent(bundle.files, "settings/documents.json"),
    ) as Array<{
      title: string;
      href: string;
    }>;
    const search = JSON.parse(
      fileContent(bundle.files, "search/index.json"),
    ) as {
      schemaVersion: number;
      contentVersion: string;
      documents: Array<{
        id: string;
        slug: string;
        title: string;
        headings: string[];
        content: string;
      }>;
    };

    expect(documents).toEqual([
      { title: "Overview", href: "/" },
      { title: "API", href: "/reference/api" },
    ]);
    expect(search.schemaVersion).toBe(1);
    expect(search.contentVersion).toBe("version-1");
    expect(search.documents[0]).toMatchObject({
      id: "/",
      slug: "/",
      title: "Overview",
      headings: [],
    });
    expect(search.documents[0].content).not.toContain("---");
    expect(search.documents.map((document) => document.title)).toEqual([
      "Overview",
      "API",
    ]);
  });
});

function fileContent(
  files: Array<{ path: string; content: string }>,
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing test artifact: ${path}`);
  return file.content;
}

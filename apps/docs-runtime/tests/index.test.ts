import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocsAccessPolicy } from "@doxahq/contracts";
import { createRuntimeDocsArtifacts } from "@doxahq/docs-engine";
import worker, { renderMarkdown } from "../src/index";
import {
  resetRuntimeSourceCachesForTests,
  runHostRuntimeRequest,
  runResolvedRuntimeRequest,
} from "../src/runtime-source";
import { testExecutionContext } from "./support/execution-context";
import { createTreeBucket, treeBucketOf } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

describe("renderMarkdown", () => {
  test("renders the supported MVP Markdown subset safely", () => {
    const rendered = renderMarkdown(`---
title: Runtime Page
description: Runtime description
---

# Runtime Page

Paragraph with \`code\`, [safe](/safe), [external](https://doxa.so), [bad](javascript:alert(1)) and <script>.

- One
- Two

1. First
2. Second

| Name | Value |
| --- | --- |
| Doxa | Docs |

\`\`\`ts
const value = "<escaped>";
\`\`\`
`);

    expect(rendered.title).toBe("Runtime Page");
    expect(rendered.description).toBe("Runtime description");
    expect(rendered.html).toContain("<h1>Runtime Page</h1>");
    expect(rendered.html).toContain("<code>code</code>");
    expect(rendered.html).toContain('<a href="/safe">safe</a>');
    expect(rendered.html).toContain('<a href="https://doxa.so">external</a>');
    expect(rendered.html).toContain('<a href="#">bad</a>');
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("<ul><li>One</li><li>Two</li></ul>");
    expect(rendered.html).toContain("<ol><li>First</li><li>Second</li></ol>");
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).toContain('class="language-ts"');
    expect(rendered.html).toContain("&lt;escaped&gt;");
  });

  test.each([
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "//evil.example",
    "/\\evil.example",
  ])("replaces the unsafe link %j with #", (href) => {
    const rendered = renderMarkdown(`---
title: Links
---

[bad](${href})
`);

    expect(rendered.html).toContain('<a href="#">bad</a>');
  });

  test.each(["/guide", "./guide", "../guide", "guide", "#install", "?tab=1", "HTTPS://doxa.so", "mailto:a@doxa.so"])(
    "keeps the safe link %j",
    (href) => {
      const rendered = renderMarkdown(`---
title: Links
---

[good](${href})
`);

      expect(rendered.html).toContain(`<a href="${href}">good</a>`);
    },
  );

  test("removes component tags without weakening HTML escaping", () => {
    const rendered = renderMarkdown(`---
title: Components
---

<Card title="x">Text</Card>

<script>alert(1)</script>
`);

    expect(rendered.html).toContain("Text");
    expect(rendered.html).not.toContain("Card");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("docs runtime fetch", () => {
  beforeEach(() => {
    resetRuntimeSourceCachesForTests();
  });

  afterEach(() => {
    resetRuntimeSourceCachesForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("renders generated navigation groups and separate sections from docs-engine artifacts", async () => {
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
      ],
      navigation: {
        sections: [
          {
            slug: "default",
            items: ["default/overview.md", "default/quickstart.md"],
            groups: [
              {
                heading: "Start Here",
                items: ["default/overview.md", "default/quickstart.md"],
              },
            ],
          },
          {
            slug: "rest-api",
            items: ["rest-api/health.md"],
            groups: [{ heading: "Status", items: ["rest-api/health.md"] }],
          },
        ],
        icons: {
          "default/overview.md": "compass",
          "default/quickstart.md": "rocket",
          "rest-api/health.md": "server",
        },
        navTitles: {
          "default/overview.md": "Overview",
          "default/quickstart.md": "Quickstart",
          "rest-api/health.md": "Health",
        },
        navBadges: { "rest-api/health.md": "GET" },
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
        },
      },
    });
    const objects = Object.fromEntries(
      bundle.files.map((file) => [
        `sites/site-1/versions/version-1/${file.path}`,
        file.content,
      ]),
    );
    const env = createEnv({ objects });

    const sectionsResponse = await runtimeRequest(env, "getSections");
    const sectionsPayload = (await sectionsResponse.json()) as {
      ok: true;
      data: unknown;
    };
    expect(sectionsPayload.data).toEqual([
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
        default: false,
        kind: "reference",
        layout: "reference",
      },
    ]);

    const docsResponse = await runtimeRequest(env, "getNavigation", {
      sectionSlug: "default",
    });
    const docsPayload = (await docsResponse.json()) as {
      ok: true;
      data: unknown;
    };
    expect(docsPayload.data).toEqual([
      { heading: "Start Here" },
      { title: "Overview", href: "/", icon: "compass" },
      { title: "Quickstart", href: "/quickstart", icon: "rocket" },
    ]);

    const apiResponse = await runtimeRequest(env, "getNavigation", {
      sectionSlug: "rest-api",
    });
    const apiPayload = (await apiResponse.json()) as {
      ok: true;
      data: unknown;
    };
    expect(apiPayload.data).toEqual([
      { heading: "Status" },
      {
        title: "Health",
        href: "/rest-api/health",
        icon: "server",
        badge: "GET",
      },
    ]);
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-022): production serves no HTML from this Worker.
  test("answers 404 for the landing page and docs pages without the HTML preview flag", async () => {
    const env = { ...createEnv({ objects: {} }), DOCS_RUNTIME_HTML_PREVIEW: undefined };
    for (const path of ["/", "/doxa-demo", "/doxa-demo/install"]) {
      const response = await worker.fetch(new Request(`https://preview.doxa.so${path}`), env, {} as never);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
    }
  });

  test("escapes navigation hrefs in the HTML preview", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
            { title: "Evil", href: '/x"><script>alert(1)</script>', sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx": "# Overview",
      },
    });

    const response = await worker.fetch(new Request("https://preview.doxa.so/doxa-demo"), env, {} as never);
    const html = await response.text();

    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("renders a published docs page through the service-bound API and R2 artifacts", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
            {
              title: "Install",
              href: "/install",
              sourcePath: "source/install/index.mdx",
            },
          ],
        }),
        "sites/site-1/versions/version-1/settings/documents.json":
          JSON.stringify([
            { title: "Install", href: "/install" },
            { title: "Overview", href: "/" },
          ]),
        "sites/site-1/versions/version-1/source/index.mdx":
          "---\ntitle: Doxa Demo\n---\n\n# Doxa Demo\n\nHello.",
      },
    });

    const response = await worker.fetch(
      new Request("http://docs.test/doxa-demo"),
      env,
      testExecutionContext(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300",
    );
    expect(html).toContain("<h1>Doxa Demo</h1>");
    expect(html.indexOf(">Install</a>")).toBeLessThan(
      html.indexOf(">Overview</a>"),
    );
  });

  test("falls back to manifest navigation when settings documents are missing", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx": "# Overview",
      },
    });

    const response = await worker.fetch(
      new Request("http://docs.test/doxa-demo"),
      env,
      testExecutionContext(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(">Overview</a>");
  });

  test("does not use public HTTP fallback when service binding exists and fallback is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const env = createEnv({
      objects: {},
      api: {
        resolveDocsSite: async () => {
          throw new Error("rpc unavailable");
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://docs.test/doxa-demo"),
      env,
      testExecutionContext(),
    );
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(html).toContain("No published docs for doxa-demo");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("serves runtime-source page data for the authenticated project id", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
            {
              title: "Install",
              href: "/install",
              sourcePath: "source/install/index.mdx",
            },
          ],
        }),
        "sites/site-1/versions/version-1/settings/documents.json":
          JSON.stringify([
            { title: "Install", href: "/install" },
            { title: "Overview", href: "/" },
          ]),
        "sites/site-1/versions/version-1/settings/sections.json":
          JSON.stringify([{ slug: "default", label: "Docs" }]),
        "sites/site-1/versions/version-1/source/install/index.mdx":
          "---\ntitle: Install Doxa\ndescription: Install docs\nkeywords: cli, docs\n---\n\n# Install\n\n## Setup\n\nBody.",
      },
    });

    const response = await runtimeRequest(env, "resolvePage", {
      pathname: "/install",
    });
    const payload = (await response.json()) as {
      ok: true;
      data: {
        type: "page";
        page: {
          title: string;
          description: string;
          keywords: string[];
          sectionSlug: string;
          body: string;
          headings: Array<{ text: string; href: string }>;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe(
      "authorization, x-doxa-host, x-doxa-project-id",
    );
    expect(payload.ok).toBe(true);
    expect(payload.data.type).toBe("page");
    expect(payload.data.page.title).toBe("Install Doxa");
    expect(payload.data.page.description).toBe("Install docs");
    expect(payload.data.page.keywords).toEqual(["cli", "docs"]);
    expect(payload.data.page.sectionSlug).toBe("default");
    expect(payload.data.page.body).toContain("# Install");
    expect(payload.data.page.headings).toEqual([
      { level: 2, text: "Setup", href: "#setup" },
    ]);
  });

  test("serves the prebuilt search index without rebuilding it in the browser", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [
        {
          title: "Overview",
          route: "/",
          content: "# Overview\n\nSearchable documentation.",
        },
      ],
    });
    const env = createEnv({
      objects: Object.fromEntries(
        bundle.files.map((file) => [
          `sites/site-1/versions/version-1/${file.path}`,
          file.content,
        ]),
      ),
    });

    const response = await runtimeRequest(env, "getCompiledSearchIndex");
    const payload = (await response.json()) as {
      ok: true;
      data: string | null;
    };

    expect(response.status).toBe(200);
    expect(payload.data).toContain('"contentVersion":"version-1"');
    expect(payload.data).toContain("Searchable documentation");
  });

  test("serves a dispatcher-pinned version without resolving a mutable host", async () => {
    const resolveDocsHost = vi.fn();
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-09-09T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx":
          "# Pinned production docs",
      },
      api: { resolveDocsHost },
    });

    const result = await runResolvedRuntimeRequest(env, {
      resolution: {
        siteId: "site-1",
        projectId: "project-1",
        projectSlug: "doxa-demo",
        publishedVersionId: "version-1",
        artifactPrefix: "sites/site-1/versions/version-1",
        manifestPath: "sites/site-1/versions/version-1/manifest.json",
        accessPolicy: "public",
      },
      operation: "getRawPage",
      payload: { slug: "/" },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { title: "Overview", body: "# Pinned production docs" },
    });
    expect(resolveDocsHost).not.toHaveBeenCalled();
  });

  test("uses the resolved hostname as the site URL of canonical links", async () => {
    const env = {
      ...createEnv({
        objects: {
          "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
            siteId: "site-1",
            versionId: "version-1",
            projectSlug: "doxa-demo",
            generatedAt: "2026-09-09T00:00:00.000Z",
            pages: [
              { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
            ],
          }),
          "sites/site-1/versions/version-1/source/index.mdx": "# Overview",
        },
      }),
      DOCS_PUBLIC_BASE_URL: "https://preview.doxa.so",
    };
    const resolution = {
      siteId: "site-1",
      projectId: "project-1",
      projectSlug: "doxa-demo",
      publishedVersionId: "version-1",
      artifactPrefix: "sites/site-1/versions/version-1",
      manifestPath: "sites/site-1/versions/version-1/manifest.json",
      accessPolicy: "public" as const,
    };
    const siteUrl = (siteUrlValue?: string) =>
      runResolvedRuntimeRequest(env, {
        resolution: {
          ...resolution,
          ...(siteUrlValue ? { siteUrl: siteUrlValue } : {}),
        },
        operation: "getSiteConfig",
      });

    expect(await siteUrl("https://docs.acme.com")).toMatchObject({
      ok: true,
      data: { url: "https://docs.acme.com" },
    });
    expect(await siteUrl("https://acme.doxa.page")).toMatchObject({
      ok: true,
      data: { url: "https://acme.doxa.page" },
    });
    // A call without a resolved hostname keeps the environment value.
    expect(await siteUrl()).toMatchObject({
      ok: true,
      data: { url: "https://preview.doxa.so" },
    });
    // A site URL with a path is not an origin: the request is refused.
    expect(await siteUrl("https://docs.acme.com/evil")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  test("serves a promoted version that reuses an immutable artifact", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/source-version/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "source-version",
          projectSlug: "doxa-demo",
          generatedAt: "2026-09-09T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/source-version/source/index.mdx":
          "# Promoted production docs",
      },
    });

    const result = await runResolvedRuntimeRequest(env, {
      resolution: {
        siteId: "site-1",
        projectId: "project-1",
        projectSlug: "doxa-demo",
        publishedVersionId: "production-clone",
        artifactPrefix: "sites/site-1/versions/source-version",
        manifestPath: "sites/site-1/versions/source-version/manifest.json",
        accessPolicy: "public",
      },
      operation: "getRawPage",
      payload: { slug: "/" },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { title: "Overview", body: "# Promoted production docs" },
    });
  });

  test("rejects a pinned resolution whose path does not match the manifest", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/wrong-version/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "source-version",
          projectSlug: "doxa-demo",
          generatedAt: "2026-09-09T00:00:00.000Z",
          pages: [],
        }),
      },
    });

    const result = await runResolvedRuntimeRequest(env, {
      resolution: {
        siteId: "site-1",
        projectId: "project-1",
        projectSlug: "doxa-demo",
        publishedVersionId: "production-clone",
        artifactPrefix: "sites/site-1/versions/wrong-version",
        manifestPath: "sites/site-1/versions/wrong-version/manifest.json",
        accessPolicy: "public",
      },
      operation: "getRawPage",
      payload: { slug: "/" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "version_not_found",
        message: "The pinned documentation version is unavailable.",
      },
    });
  });

  test("serves shared renderer content through a host-scoped RPC", async () => {
    const resolveDocsHost = vi.fn(async () => ({
      siteId: "site-1",
      projectId: "project-1",
      projectSlug: "doxa-demo",
      publishedVersionId: "version-1",
      artifactPrefix: "sites/site-1/versions/version-1",
      manifestPath: "sites/site-1/versions/version-1/manifest.json",
      accessPolicy: "public" as const,
      hostname: "docs.example.com",
      domainKind: "custom_domain" as const,
      renderTarget: "production" as const,
    }));
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-09-09T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx": "# Shared docs",
      },
      api: { resolveDocsHost },
    });

    const result = await runHostRuntimeRequest(env, {
      hostname: "DOCS.EXAMPLE.COM",
      operation: "getRawPage",
      payload: { slug: "/" },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { body: "# Shared docs" },
    });
    expect(resolveDocsHost).toHaveBeenCalledWith("docs.example.com");
  });

  test("resolves the root to the first published navigation page", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            {
              title: "Quickstart",
              href: "/quickstart",
              sourcePath: "source/quickstart/index.mdx",
            },
          ],
        }),
        "sites/site-1/versions/version-1/settings/documents.json":
          JSON.stringify([
            { heading: "Start Here" },
            { title: "Quickstart", href: "/quickstart" },
          ]),
        "sites/site-1/versions/version-1/settings/sections.json":
          JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
        "sites/site-1/versions/version-1/source/quickstart/index.mdx":
          "---\ntitle: Quickstart\ndescription: Start here\n---\n\n# Quickstart",
      },
    });

    const response = await runtimeRequest(env, "getRouteData", {
      pathname: "/",
    });
    const payload = (await response.json()) as {
      ok: true;
      data: {
        type: "page";
        href: string;
        slug: string;
        page: { href: string; title: string };
      };
    };

    expect(payload.data).toMatchObject({
      type: "page",
      href: "/quickstart",
      slug: "quickstart",
      page: { href: "/quickstart", title: "Quickstart" },
    });
  });

  test("serves one-shot runtime route data for platform renderers", async () => {
    const resolveDocsProject = vi.fn(async (projectId: string) =>
      projectId === "project-1"
        ? {
            siteId: "site-1",
            projectId: "project-1",
            projectSlug: "doxa-demo",
            publishedVersionId: "version-1",
            artifactPrefix: "sites/site-1/versions/version-1",
            manifestPath: "sites/site-1/versions/version-1/manifest.json",
            accessPolicy: PUBLIC_ACCESS_POLICY,
          }
        : null,
    );
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
            {
              title: "Install",
              href: "/install",
              sourcePath: "source/install/index.mdx",
            },
          ],
        }),
        "sites/site-1/versions/version-1/settings/documents.json":
          JSON.stringify([
            { heading: "Start" },
            {
              title: "Overview",
              href: "/",
              items: [{ title: "Install", href: "/install" }],
            },
          ]),
        "sites/site-1/versions/version-1/settings/sections.json":
          JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
        "sites/site-1/versions/version-1/settings/features.json":
          JSON.stringify({
            apiPlayground: false,
          }),
        "sites/site-1/versions/version-1/source/install/index.mdx":
          "---\ntitle: Get a user\ndescription: Return one user\napiMethod: GET\napiPath: /v1/users/{userId}\n---\n\n# User\n\n## Response\n\nBody.",
      },
      api: { resolveDocsProject },
    });

    const response = await runtimeRequest(env, "getRouteData", {
      pathname: "/install",
    });
    const payload = (await response.json()) as {
      ok: true;
      data: {
        type: "page";
        href: string;
        slug: string;
        routeTitle: string | null;
        sectionHeading: string | null;
        sectionHomeHrefs: Record<string, string>;
        sectionNavigation: Array<{
          title?: string;
          href?: string;
          heading?: string;
        }>;
        sectionRoutes: Array<{ title: string; href: string }>;
        features: { apiPlayground: boolean; tableOfContents: boolean };
        previous: { href: string } | null;
        next: { href: string } | null;
        page: {
          title: string;
          apiMethod?: string;
          apiPath?: string;
          body: string;
          headings: Array<{ text: string; href: string }>;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.type).toBe("page");
    expect(payload.data.features).toMatchObject({
      apiPlayground: false,
      tableOfContents: true,
    });
    expect(payload.data.href).toBe("/install");
    expect(payload.data.slug).toBe("install");
    expect(payload.data.routeTitle).toBe("Install");
    expect(payload.data.sectionHeading).toBe("Start");
    expect(payload.data.sectionHomeHrefs).toEqual({ default: "/" });
    expect(payload.data.sectionNavigation).toEqual([
      { heading: "Start" },
      { title: "Overview", href: "/" },
      { title: "Install", href: "/install" },
    ]);
    expect(payload.data.sectionRoutes).toEqual([
      { title: "Overview", href: "/" },
      { title: "Install", href: "/install" },
    ]);
    expect(payload.data.previous?.href).toBe("/");
    expect(payload.data.next).toBeNull();
    expect(payload.data.page.title).toBe("Get a user");
    expect(payload.data.page.apiMethod).toBe("GET");
    expect(payload.data.page.apiPath).toBe("/v1/users/{userId}");
    expect(payload.data.page.body).toContain("# User");
    expect(payload.data.page.headings).toEqual([
      { level: 2, text: "Response", href: "#response" },
    ]);
    expect(resolveDocsProject).toHaveBeenCalledTimes(1);
  });

  test("returns a bounded pre-render plan from the pinned manifest and sections", async () => {
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
        {
          title: "API",
          route: "/rest-api/health",
          navigationPath: "rest-api/health.md",
          content: "---\ntitle: API\n---\n\n# API",
        },
      ],
      navigation: {
        sections: [
          { slug: "default", items: ["default/overview.md"] },
          { slug: "rest-api", items: ["rest-api/health.md"] },
        ],
      },
    });
    const env = createEnv({
      objects: Object.fromEntries(
        bundle.files.map((file) => [
          `sites/site-1/versions/version-1/${file.path}`,
          file.content,
        ]),
      ),
    });

    const response = await runtimeRequest(env, "getPrerenderPlan");
    const payload = (await response.json()) as {
      ok: true;
      data: Array<{ kind: string; pathname: string; target?: string }>;
    };

    expect(payload.data).toEqual([
      { kind: "page", pathname: "/" },
      { kind: "page", pathname: "/overview" },
      {
        kind: "redirect",
        pathname: "/rest-api",
        target: "/rest-api/health",
        status: 308,
      },
      { kind: "page", pathname: "/rest-api/health" },
    ]);
  });

  describe("a page at the path of its section (RES-3)", () => {
    async function sectionPageEnv() {
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
          {
            title: "Create a note",
            route: "/api/notes/create",
            navigationPath: "api/create.md",
            content: "---\ntitle: Create a note\n---\n\n# Create a note",
          },
          {
            title: "API overview",
            route: "/api",
            navigationPath: "api/overview.md",
            content: "---\ntitle: API overview\n---\n\n# API overview",
          },
          {
            title: "Health",
            route: "/rest-api/health",
            navigationPath: "rest-api/health.md",
            content: "---\ntitle: Health\n---\n\n# Health",
          },
        ],
        navigation: {
          sections: [
            { slug: "default", items: ["default/overview.md"] },
            { slug: "api", items: ["api/create.md", "api/overview.md"] },
            { slug: "rest-api", items: ["rest-api/health.md"] },
          ],
        },
      });
      return createEnv({
        objects: Object.fromEntries(
          bundle.files.map((file) => [
            `sites/site-1/versions/version-1/${file.path}`,
            file.content,
          ]),
        ),
      });
    }

    test("plans the page and no section redirect for that path", async () => {
      const response = await runtimeRequest(
        await sectionPageEnv(),
        "getPrerenderPlan",
      );
      const payload = (await response.json()) as { ok: boolean; data: unknown };

      expect(payload.ok).toBe(true);
      expect(payload.data).toEqual([
        { kind: "page", pathname: "/" },
        { kind: "page", pathname: "/api" },
        { kind: "page", pathname: "/api/notes/create" },
        { kind: "page", pathname: "/overview" },
        {
          kind: "redirect",
          pathname: "/rest-api",
          target: "/rest-api/health",
          status: 308,
        },
        { kind: "page", pathname: "/rest-api/health" },
      ]);
    });

    test("serves the page live, and still redirects a section without one", async () => {
      const env = await sectionPageEnv();
      const page = (await (
        await runtimeRequest(env, "getRouteData", { pathname: "/api" })
      ).json()) as { data: { type: string; href: string } };
      const section = (await (
        await runtimeRequest(env, "getRouteData", { pathname: "/rest-api" })
      ).json()) as { data: { type: string; href: string } };

      expect(page.data).toMatchObject({ type: "page", href: "/api" });
      expect(section.data).toMatchObject({
        type: "redirect",
        href: "/rest-api/health",
      });
    });
  });

  test("marks an empty site root as live-only", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      projectName: "Doxa Demo",
      pages: [],
      navigation: { sections: [] },
    });
    const env = createEnv({
      objects: Object.fromEntries(
        bundle.files.map((file) => [
          `sites/site-1/versions/version-1/${file.path}`,
          file.content,
        ]),
      ),
    });

    const response = await runtimeRequest(env, "getPrerenderPlan");
    const payload = (await response.json()) as { ok: true; data: unknown };

    expect(payload.data).toEqual([
      { kind: "live_only", pathname: "/", reason: "unsupported_route" },
    ]);
  });

  test("deduplicates stable runtime artifacts inside one-shot route data requests", async () => {
    const env = createEnv({
      objects: routeDataObjects(),
    });

    const response = await runtimeRequest(env, "getRouteData", {
      pathname: "/install",
    });

    expect(response.status).toBe(200);
    expect(
      await getBucketReadCount(env, "sites/site-1/versions/version-1/manifest.json"),
    ).toBe(1);
    expect(
      await getBucketReadCount(
        env,
        "sites/site-1/versions/version-1/settings/sections.json",
      ),
    ).toBe(1);
    expect(
      await getBucketReadCount(
        env,
        "sites/site-1/versions/version-1/settings/documents.json",
      ),
    ).toBe(1);
    expect(
      await getBucketReadCount(
        env,
        "sites/site-1/versions/version-1/source/install/index.mdx",
      ),
    ).toBe(1);
  });

  test("refreshes the published pointer and reuses its stable artifacts", async () => {
    const resolveDocsProject = vi.fn(async (projectId: string) =>
      projectId === "project-1"
        ? {
            siteId: "site-1",
            projectId: "project-1",
            projectSlug: "doxa-demo",
            publishedVersionId: "version-1",
            artifactPrefix: "sites/site-1/versions/version-1",
            manifestPath: "sites/site-1/versions/version-1/manifest.json",
            accessPolicy: PUBLIC_ACCESS_POLICY,
          }
        : null,
    );
    const env = createEnv({
      objects: routeDataObjects(),
      api: { resolveDocsProject },
    });

    const first = await runtimeRequest(env, "getRouteData", {
      pathname: "/install",
    });
    const second = await runtimeRequest(env, "getRouteData", {
      pathname: "/install",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(resolveDocsProject).toHaveBeenCalledTimes(2);
    expect(
      await getBucketReadCount(env, "sites/site-1/versions/version-1/manifest.json"),
    ).toBe(1);
    expect(
      await getBucketReadCount(
        env,
        "sites/site-1/versions/version-1/settings/sections.json",
      ),
    ).toBe(1);
    expect(
      await getBucketReadCount(
        env,
        "sites/site-1/versions/version-1/settings/documents.json",
      ),
    ).toBe(1);
    expect(
      await getBucketReadCount(
        env,
        "sites/site-1/versions/version-1/source/install/index.mdx",
      ),
    ).toBe(1);
  });

  test("serves a newly published version on the next runtime request", async () => {
    let publishedVersion = "version-1";
    const resolveDocsProject = vi.fn(async () => ({
      siteId: "site-1",
      projectId: "project-1",
      projectSlug: "doxa-demo",
      publishedVersionId: publishedVersion,
      artifactPrefix: `sites/site-1/versions/${publishedVersion}`,
      manifestPath: `sites/site-1/versions/${publishedVersion}/manifest.json`,
      accessPolicy: PUBLIC_ACCESS_POLICY,
    }));
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-08-20T12:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx":
          "# Current production",
        "sites/site-1/versions/version-2/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-2",
          projectSlug: "doxa-demo",
          generatedAt: "2026-08-20T12:01:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-2/source/index.mdx":
          "# Promoted production",
      },
      api: { resolveDocsProject },
    });

    const beforePromotion = await runtimeRequest(env, "getRawPage", {
      slug: "/",
    });
    publishedVersion = "version-2";
    const afterPromotion = await runtimeRequest(env, "getRawPage", {
      slug: "/",
    });

    await expect(beforePromotion.json()).resolves.toMatchObject({
      ok: true,
      data: { body: "# Current production" },
    });
    await expect(afterPromotion.json()).resolves.toMatchObject({
      ok: true,
      data: { body: "# Promoted production" },
    });
  });

  test("serves runtime-source page data for the authenticated docs host", async () => {
    const resolveDocsHost = vi.fn(async (hostname: string) =>
      hostname === "Docs.Example.com"
        ? {
            siteId: "site-1",
            projectId: "project-1",
            projectSlug: "doxa-demo",
            publishedVersionId: "version-1",
            artifactPrefix: "sites/site-1/versions/version-1",
            manifestPath: "sites/site-1/versions/version-1/manifest.json",
            accessPolicy: PUBLIC_ACCESS_POLICY,
            hostname: "docs.example.com",
            domainKind: "custom_domain" as const,
          }
        : null,
    );
    const resolveDocsProject = vi.fn(async () => null);
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx":
          "# Host Scoped Docs",
      },
      api: {
        resolveDocsHost,
        resolveDocsProject,
      },
    });

    const response = await runtimeRequest(
      env,
      "getRawPage",
      { slug: "/" },
      { hostname: "Docs.Example.com" },
    );
    const payload = (await response.json()) as {
      ok: true;
      data: { body: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.body).toBe("# Host Scoped Docs");
    expect(resolveDocsHost).toHaveBeenCalledWith("Docs.Example.com");
    expect(resolveDocsProject).not.toHaveBeenCalled();
  });

  test("serves runtime-source page data for generated Doxa preview hosts", async () => {
    const resolveDocsHost = vi.fn(async (hostname: string) =>
      hostname === "demo.doxa.page"
        ? {
            siteId: "site-1",
            projectId: "project-1",
            projectSlug: "demo",
            publishedVersionId: "version-1",
            artifactPrefix: "sites/site-1/versions/version-1",
            manifestPath: "sites/site-1/versions/version-1/manifest.json",
            accessPolicy: PUBLIC_ACCESS_POLICY,
            hostname: "demo.doxa.page",
            domainKind: "doxa_subdomain" as const,
          }
        : null,
    );
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx":
          "# Generated Preview",
      },
      api: {
        resolveDocsHost,
      },
    });

    const response = await runtimeRequest(
      env,
      "getRawPage",
      { slug: "/" },
      { hostname: "demo.doxa.page" },
    );
    const payload = (await response.json()) as {
      ok: true;
      data: { body: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.body).toBe("# Generated Preview");
    expect(resolveDocsHost).toHaveBeenCalledWith("demo.doxa.page");
  });

  test("rejects runtime-source requests without the configured token", async () => {
    const env = createEnv({ objects: {} });
    const response = await worker.fetch(
      new Request("http://docs.test/runtime-source", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
          "x-doxa-project-id": "project-1",
        },
        body: JSON.stringify({ operation: "getHomeHref" }),
      }),
      env,
      testExecutionContext(),
    );
    const payload = (await response.json()) as {
      ok: false;
      error: { code: string };
    };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("unauthorized");
  });

  test("runtime-source resolves content only from the project id header", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx": "# Project One",
      },
    });

    const response = await runtimeRequest(env, "getRawPage", {
      slug: "/",
      projectId: "project-2",
      artifactPrefix: "sites/site-2/versions/version-9",
    });
    const payload = (await response.json()) as {
      ok: true;
      data: { body: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.body).toBe("# Project One");
  });

  test("runtime-source resolves content only from the host header", async () => {
    const env = createEnv({
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx": "# Host Project",
      },
      api: {
        resolveDocsHost: async () => ({
          siteId: "site-1",
          projectId: "project-1",
          projectSlug: "doxa-demo",
          publishedVersionId: "version-1",
          artifactPrefix: "sites/site-1/versions/version-1",
          manifestPath: "sites/site-1/versions/version-1/manifest.json",
          accessPolicy: PUBLIC_ACCESS_POLICY,
          hostname: "docs.example.com",
          domainKind: "custom_domain",
        }),
      },
    });

    const response = await runtimeRequest(
      env,
      "getRawPage",
      {
        slug: "/",
        hostname: "other.example.com",
        artifactPrefix: "sites/site-2/versions/version-9",
      },
      { hostname: "docs.example.com" },
    );
    const payload = (await response.json()) as {
      ok: true;
      data: { body: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.body).toBe("# Host Project");
  });

  test("rejects runtime-source requests without project or host scope", async () => {
    const env = createEnv({ objects: {} });
    const response = await runtimeRequest(env, "getHomeHref", undefined, {
      projectId: null,
    });
    const payload = (await response.json()) as {
      ok: false;
      error: { code: string };
    };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("missing_runtime_scope");
  });

  test("emits opt-in runtime-source timing logs without exposing content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = createEnv({
      timing: "true",
      objects: {
        "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
          siteId: "site-1",
          versionId: "version-1",
          projectSlug: "doxa-demo",
          generatedAt: "2026-06-14T00:00:00.000Z",
          pages: [
            { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
          ],
        }),
        "sites/site-1/versions/version-1/source/index.mdx": "# Private Body",
      },
    });

    const response = await runtimeRequest(env, "getRawPage", { slug: "/" });
    const logLines = info.mock.calls.map((call) => String(call[1] ?? ""));

    expect(response.status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      "[doxa-docs-runtime:timing]",
      expect.stringContaining('"event":"request.complete"'),
    );
    expect(
      logLines.some((line) => line.includes('"event":"artifact.bucketGet"')),
    ).toBe(true);
    expect(
      logLines.some((line) => line.includes('"artifactKind":"manifest"')),
    ).toBe(true);
    expect(logLines.some((line) => line.includes("# Private Body"))).toBe(
      false,
    );
  });
});

function routeDataObjects(): Record<string, string> {
  return {
    "sites/site-1/versions/version-1/manifest.json": JSON.stringify({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "doxa-demo",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pages: [
        { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
        {
          title: "Install",
          href: "/install",
          sourcePath: "source/install/index.mdx",
        },
      ],
    }),
    "sites/site-1/versions/version-1/settings/documents.json": JSON.stringify([
      { heading: "Start" },
      {
        title: "Overview",
        href: "/",
        items: [{ title: "Install", href: "/install" }],
      },
    ]),
    "sites/site-1/versions/version-1/settings/sections.json": JSON.stringify([
      { slug: "default", label: "Docs", default: true },
    ]),
    "sites/site-1/versions/version-1/source/install/index.mdx":
      "---\ntitle: Install Doxa\ndescription: Install docs\n---\n\n# Install\n\n## Setup\n\nBody.",
  };
}

/** Reads of one logical file, counted at its content-addressed blob. */
async function getBucketReadCount(
  env: Parameters<typeof worker.fetch>[1],
  path: string,
): Promise<number> {
  const blobKey = await treeBucketOf(env.DOCS_BUCKET).blobKeyOf(path);
  const bucketGet = env.DOCS_BUCKET.get as unknown as {
    mock: { calls: Array<[string]> };
  };
  return bucketGet.mock.calls.filter(([candidate]) => candidate === blobKey)
    .length;
}

function createEnv(input: {
  objects: Record<string, string>;
  api?: Partial<NonNullable<Parameters<typeof worker.fetch>[1]["API"]>>;
  timing?: string;
}): Parameters<typeof worker.fetch>[1] {
  return {
    API: {
      resolveDocsSite: async () => ({
        siteId: "site-1",
        projectId: "project-1",
        projectSlug: "doxa-demo",
        publishedVersionId: "version-1",
        artifactPrefix: "sites/site-1/versions/version-1",
        manifestPath: "sites/site-1/versions/version-1/manifest.json",
        accessPolicy: PUBLIC_ACCESS_POLICY,
      }),
      resolveDocsProject: async (projectId: string) =>
        projectId === "project-1"
          ? {
              siteId: "site-1",
              projectId: "project-1",
              projectSlug: "doxa-demo",
              publishedVersionId: "version-1",
              artifactPrefix: "sites/site-1/versions/version-1",
              manifestPath: "sites/site-1/versions/version-1/manifest.json",
              accessPolicy: PUBLIC_ACCESS_POLICY,
            }
          : null,
      resolveDocsHost: async () => null,
      readDocsArtifact: async () => null,
      getGenerationContext: async () => null,
      getGenerationExecutionContext: async () => null,
      getGenerationDatabaseCompatibility: async () => ({
        ready: true,
        missingColumns: [],
      }),
      getCurrentChangeProposalState: async () => null,
      createInstallationAccessToken: async () => "",
      createRepositoryReadToken: async () => "",
      createModelAccessToken: vi.fn(async () => null),
      markJobRunning: async () => undefined,
      markJobFailed: async () => undefined,
      markJobCancelled: async () => undefined,
      markJobSuperseded: async () => undefined,
      isJobActive: async () => true,
      getGenerationResumedAt: async () => null,
      getGenerationControl: async () => ({
        status: "enabled",
        reason: null,
        updatedByUserId: null,
        updatedAt: null,
      }),
      listStaleGenerationJobs: async () => [],
      addJobEvent: async () => ({
        id: "event-1",
        jobId: "job-1",
        sequence: 1,
        source: "api",
        type: "test",
        message: "test",
        data: null,
        createdAt: "2026-06-14T00:00:00.000Z",
      }),
      recordGenerationUsage: async () => undefined,
      recordGenerationDiagnostic: async () => undefined,
      getGenerationUsageSummary: async () => null,
      deleteExpiredGenerationObservability: async () => ({
        diagnostics: 0,
      }),
      publishJobOutput: async () => ({ versionId: "version-1" }),
      completeJobOutput: async () => ({
        versionId: "11111111-1111-4111-8111-111111111111",
        previewUrl: null,
      }),
      createReviewRun: async () => ({
        externalRunId: "9001",
        outcome: "created",
      }),
      updateReviewRun: async () => ({
        externalRunId: "9001",
        outcome: "updated",
      }),
      ...input.api,
    },
    DOCS_BUCKET: createTreeBucket(input.objects).bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_RUNTIME_HTML_PREVIEW: "on",
    ...(input.timing ? { DOXA_DOCS_RUNTIME_TIMING: input.timing } : {}),
  };
}

function runtimeRequest(
  env: Parameters<typeof worker.fetch>[1],
  operation: string,
  payload?: unknown,
  scope: { projectId?: string | null; hostname?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: "Bearer test-runtime-token",
    "content-type": "application/json",
  };
  const projectId =
    scope.projectId === undefined ? "project-1" : scope.projectId;
  if (projectId) headers["x-doxa-project-id"] = projectId;
  if (scope.hostname) headers["x-doxa-host"] = scope.hostname;

  return worker.fetch(
    new Request("http://docs.test/runtime-source", {
      method: "POST",
      headers,
      body: JSON.stringify({ operation, payload }),
    }),
    env,
    testExecutionContext(),
  );
}
const PUBLIC_ACCESS_POLICY: DocsAccessPolicy = "public";

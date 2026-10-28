import type {
  DoxaDocsRuntimeSource,
  RuntimeNavPage,
  RuntimeRawPage,
  RuntimeSection,
} from "@/src/runtime/runtime-source";
import { RuntimeSourceError } from "@/src/runtime/runtime-source-error";
import { resolveSiteConfig } from "@doxahq/site-config";
import { describe, expect, test, vi } from "vitest";

import {
  createLlmsResponse,
  formatLlmsFull,
  formatLlmsIndex,
  loadLlmsSections,
  type LlmsSite,
} from "./llms";

const ORIGIN = "https://acme.doxa.page";

interface FakeSite {
  sections: RuntimeSection[];
  routes: Record<string, RuntimeNavPage[]>;
  pages: Record<string, RuntimeRawPage>;
}

function rawPage(href: string, title: string, body: string): RuntimeRawPage {
  return {
    slug: href.slice(1),
    href,
    title,
    description: `About ${title}`,
    sourcePath: `${href.slice(1)}/index.mdx`,
    body,
  };
}

const ACME: FakeSite = {
  sections: [
    { slug: "docs", label: "Documentation", default: true },
    { slug: "api", label: "API Reference" },
    { slug: "internal", label: "Internal", hidden: true },
  ],
  routes: {
    docs: [
      { title: "Install", href: "/install" },
      { title: "Usage", href: "/usage/" },
      { title: "Gone", href: "/gone" },
    ],
    api: [
      { title: "Usage", href: "/usage" },
      { title: "Widgets", href: "/api/widgets" },
    ],
    internal: [{ title: "Secret", href: "/internal/secret" }],
  },
  pages: {
    "/install": rawPage(
      "/install",
      "Install",
      "---\ntitle: Install\n---\n\nRun `npm install @acme/widget`.\n"
    ),
    "/usage": rawPage("/usage", "Usage", "Call `widget()`."),
    "/api/widgets": rawPage("/api/widgets", "Widgets", "GET /widgets"),
    "/internal/secret": rawPage("/internal/secret", "Secret", "Hidden."),
  },
};

function createSource(site: FakeSite): DoxaDocsRuntimeSource {
  const unsupported = async (): Promise<never> => {
    throw new Error("The llms routes must not call this operation.");
  };
  return {
    getSections: async () => site.sections,
    getRoutes: async (sectionSlug) => site.routes[sectionSlug] ?? [],
    getRawPage: vi.fn(async (href: string) => site.pages[href] ?? null),
    getResolvedSiteConfig: async () =>
      resolveSiteConfig({ name: "Acme", description: "Acme widgets." }),
    getSiteConfig: unsupported,
    getCompanyConfig: unsupported,
    getSocialConfig: unsupported,
    getThemeConfig: unsupported,
    getFeatureConfig: unsupported,
    getNavigation: unsupported,
    getHomeHref: unsupported,
    resolvePage: unsupported,
    getPage: unsupported,
    getSearchIndex: unsupported,
  };
}

describe("loadLlmsSections", () => {
  test("lists each visible section's pages in navigation order, once", async () => {
    const sections = await loadLlmsSections(createSource(ACME), ORIGIN);

    expect(sections).toEqual([
      {
        label: "Documentation",
        documents: [
          {
            title: "Install",
            url: "https://acme.doxa.page/install",
            description: "About Install",
            content: "Run `npm install @acme/widget`.",
          },
          {
            title: "Usage",
            url: "https://acme.doxa.page/usage",
            description: "About Usage",
            content: "Call `widget()`.",
          },
        ],
      },
      {
        label: "API Reference",
        documents: [
          {
            title: "Widgets",
            url: "https://acme.doxa.page/api/widgets",
            description: "About Widgets",
            content: "GET /widgets",
          },
        ],
      },
    ]);
  });
});

const SINGLE_SECTION_SITE: LlmsSite = {
  name: "Acme",
  description: "Acme widgets.",
  sections: [
    {
      label: "Documentation",
      documents: [
        {
          title: "Install",
          url: "https://acme.doxa.page/install",
          description: "",
          content: "Run it.",
        },
      ],
    },
  ],
};

describe("formatLlmsIndex", () => {
  test("lists the pages of a single section under Docs", () => {
    expect(formatLlmsIndex(SINGLE_SECTION_SITE)).toBe(
      [
        "# Acme",
        "",
        "> Acme widgets.",
        "",
        "## Docs",
        "",
        "- [Install](https://acme.doxa.page/install)",
      ].join("\n")
    );
  });

  test("groups pages by section and leaves out empty sections", () => {
    const site: LlmsSite = {
      ...SINGLE_SECTION_SITE,
      sections: [
        ...SINGLE_SECTION_SITE.sections,
        { label: "Empty", documents: [] },
        {
          label: "API Reference",
          documents: [
            {
              title: "Widgets",
              url: "https://acme.doxa.page/api/widgets",
              description: "The widget endpoints",
              content: "GET /widgets",
            },
          ],
        },
      ],
    };

    expect(formatLlmsIndex(site)).toBe(
      [
        "# Acme",
        "",
        "> Acme widgets.",
        "",
        "## Documentation",
        "",
        "- [Install](https://acme.doxa.page/install)",
        "",
        "## API Reference",
        "",
        "- [Widgets](https://acme.doxa.page/api/widgets): The widget endpoints",
        "",
      ].join("\n")
    );
  });
});

describe("formatLlmsFull", () => {
  test("prints each page with its source URL", () => {
    expect(formatLlmsFull(SINGLE_SECTION_SITE)).toBe(
      [
        "# Acme",
        "",
        "> Acme widgets.",
        "",
        "---",
        "",
        "## Install",
        "Source: https://acme.doxa.page/install",
        "",
        "Run it.",
        "",
      ].join("\n")
    );
  });
});

describe("createLlmsResponse", () => {
  test("serves the requesting site's own pages", async () => {
    const response = await createLlmsResponse(
      new Request(`${ORIGIN}/llms.txt`),
      { runtimeSource: createSource(ACME) },
      formatLlmsIndex
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    const text = await response.text();
    expect(text).toContain("# Acme");
    expect(text).toContain("- [Install](https://acme.doxa.page/install)");
    expect(text).not.toContain("Secret");
    // The template's own demo pages never reach a site.
    expect(text).not.toContain("Agent Tools");
  });

  test("answers 404 for a host without published docs", async () => {
    const source = createSource(ACME);
    source.getSections = async () => {
      throw new RuntimeSourceError("No published docs.", "project_not_found");
    };

    const response = await createLlmsResponse(
      new Request(`${ORIGIN}/llms-full.txt`),
      { runtimeSource: source },
      formatLlmsFull
    );

    expect(response.status).toBe(404);
  });

  test("lets another runtime error fail the request", async () => {
    const source = createSource(ACME);
    source.getSections = async () => {
      throw new RuntimeSourceError("R2 read failed.", "operation_failed");
    };

    await expect(
      createLlmsResponse(
        new Request(`${ORIGIN}/llms.txt`),
        { runtimeSource: source },
        formatLlmsIndex
      )
    ).rejects.toThrow("R2 read failed.");
  });
});

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
  LLMS_FULL_LOAD_OPTIONS,
  LLMS_FULL_MAX_BYTES,
  LLMS_INDEX_LOAD_OPTIONS,
  LLMS_INDEX_READ_BYTE_BUDGET,
  loadLlmsCorpus,
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

describe("llms size limits (M46: one isolate, many sites)", () => {
  const manyPages = (count: number, bytesPerPage: number): LlmsSite => ({
    name: "Acme",
    description: "Acme widgets.",
    sections: [
      {
        label: "Documentation",
        documents: Array.from({ length: count }, (_, index) => ({
          title: `Page ${index}`,
          url: `${ORIGIN}/page-${index}`,
          description: "",
          content: "x".repeat(bytesPerPage),
        })),
      },
    ],
  });

  test("keeps a site under the limit unchanged", () => {
    const site = manyPages(3, 10);
    expect(formatLlmsFull(site, 10_000)).toBe(formatLlmsFull(site));
    expect(formatLlmsFull(site)).not.toContain("5 MB limit");
  });

  test("stops before the limit and says that pages are left out", () => {
    const text = formatLlmsFull(manyPages(50, 1_000), 10_000);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(10_000);
    expect(text).toContain("## Page 0");
    expect(text).not.toContain("## Page 49");
    expect(text.trimEnd().endsWith("/llms.txt lists every page.")).toBe(true);
  });

  test("defaults to a 5 MB limit", () => {
    const text = formatLlmsFull(manyPages(12, 512 * 1024));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      LLMS_FULL_MAX_BYTES
    );
    expect(text).toContain("5 MB limit");
  });

  test("stops reading pages once the content budget is spent", async () => {
    const pages = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `/page-${index}`,
        rawPage(`/page-${index}`, `Page ${index}`, "y".repeat(1_000)),
      ])
    );
    const source = createSource({
      sections: [{ slug: "docs", label: "Docs", default: true }],
      routes: {
        docs: Object.keys(pages).map((href) => ({ title: href, href })),
      },
      pages,
    });

    const corpus = await loadLlmsCorpus(source, ORIGIN, {
      contentByteBudget: 5_000,
    });

    expect(corpus.truncated).toBe(true);
    // At most one batch of concurrent reads past the budget.
    expect(vi.mocked(source.getRawPage).mock.calls.length).toBeLessThan(
      5 + 8 + 1
    );
  });

  test("prints the pages the loader read when it hit its budget (FC-H1)", () => {
    const text = formatLlmsFull({ ...manyPages(3, 10), truncated: true });
    expect(text).toContain("## Page 0");
    expect(text).toContain("## Page 2");
    expect(text.trimEnd().endsWith("/llms.txt lists every page.")).toBe(true);
  });

  const budgetSource = (count: number, bytesPerPage: number) => {
    const pages = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/page-${index}`,
        rawPage(`/page-${index}`, `Page ${index}`, "y".repeat(bytesPerPage)),
      ])
    );
    return createSource({
      sections: [{ slug: "docs", label: "Docs", default: true }],
      routes: {
        docs: Object.keys(pages).map((href) => ({
          title: `Nav ${href}`,
          href,
        })),
      },
      pages,
    });
  };

  test("does not flag a corpus that spends exactly its budget (FC-H1)", async () => {
    const corpus = await loadLlmsCorpus(budgetSource(4, 1_000), ORIGIN, {
      contentByteBudget: 4_000,
    });
    expect(corpus.truncated).toBe(false);
    expect(corpus.sections[0].documents).toHaveLength(4);
  });

  test("flags a corpus only when a page is left out (FC-H1)", async () => {
    const corpus = await loadLlmsCorpus(budgetSource(20, 1_000), ORIGIN, {
      contentByteBudget: 4_000,
    });
    expect(corpus.truncated).toBe(true);
    expect(corpus.sections[0].documents.length).toBeGreaterThan(0);
    expect(corpus.sections[0].documents.length).toBeLessThan(20);
  });

  test("bounds the bytes the index reads and still lists every page (FS-M2)", async () => {
    const count = 40;
    const bytesPerPage = LLMS_INDEX_READ_BYTE_BUDGET / 10;
    const source = budgetSource(count, bytesPerPage);
    const corpus = await loadLlmsCorpus(
      source,
      ORIGIN,
      LLMS_INDEX_LOAD_OPTIONS
    );
    const documents = corpus.sections[0].documents;
    expect(documents).toHaveLength(count);
    expect(corpus.truncated).toBe(false);
    expect(vi.mocked(source.getRawPage).mock.calls.length).toBeLessThan(
      10 + 8 + 1
    );
    expect(documents[count - 1]).toEqual({
      title: `Nav /page-${count - 1}`,
      url: `${ORIGIN}/page-${count - 1}`,
      description: "",
      content: "",
    });
  });

  test("leaves page content out of the index load", async () => {
    const corpus = await loadLlmsCorpus(
      createSource(ACME),
      ORIGIN,
      LLMS_INDEX_LOAD_OPTIONS
    );
    expect(
      corpus.sections.flatMap((section) =>
        section.documents.map((document) => document.content)
      )
    ).toEqual(["", "", ""]);
    expect(corpus.truncated).toBe(false);
  });

  test("serves llms-full.txt with the 5 MB budget", async () => {
    const response = await createLlmsResponse(
      new Request(`${ORIGIN}/llms-full.txt`),
      { runtimeSource: createSource(ACME) },
      formatLlmsFull,
      LLMS_FULL_LOAD_OPTIONS
    );
    const text = await response.text();
    expect(text).toContain("Run `npm install @acme/widget`.");
    expect(text).not.toContain("5 MB limit");
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

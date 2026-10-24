import {
  parsePublicDocsRouteDataV1,
  parsePublicRouteDataResponse,
  PUBLIC_DOCS_ICON_ATTRIBUTES,
  PUBLIC_DOCS_ICON_ELEMENTS,
  PUBLIC_RUNTIME_MDX_ELEMENT_NAMES,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";
import {
  CORE_ICON_NODES,
  DOCS_ICON_ATTRIBUTES,
  DOCS_ICON_ELEMENTS,
} from "@doxahq/docs-prose/icons";
import {
  RUNTIME_MDX_COMPONENT_NAMES,
  RUNTIME_MDX_INTRINSIC_NAMES,
} from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

describe("public docs route-data contract", () => {
  test.each<PublicDocsRouteDataV1>([
    { type: "redirect", href: "/guide", status: 308 },
    {
      type: "router_not_found",
      href: "/default/missing",
      slug: "default/missing",
    },
    { type: "empty", homeHref: null },
    createPageData(),
    {
      ...createPageData(),
      type: "not_found",
      document: null,
      runtimeDocument: null,
    },
  ])("round-trips the $type route state", (input) => {
    expect(
      parsePublicDocsRouteDataV1(JSON.parse(JSON.stringify(input)))
    ).toEqual(input);
  });

  test("round-trips every supported runtime MDX component", () => {
    const input = createPageData();
    if (input.type !== "page" || !input.runtimeDocument?.ok)
      throw new Error("invalid fixture");
    const names = [
      "a",
      "ApiEndpoint",
      "ApiParam",
      "ApiParams",
      "ApiRequestExample",
      "ApiResponseExample",
      "Card",
      "CardGrid",
      "File",
      "FileTree",
      "Folder",
      "Mermaid",
      "Note",
      "Step",
      "StepItem",
      "Tabs",
      "TabsContent",
      "TabsList",
      "TabsTrigger",
      "pre",
    ] as const;
    const nodes = input.runtimeDocument.document.nodes;
    nodes.length = 0;
    for (const name of names) {
      nodes.push({
        type: "element",
        name,
        props: name === "a" ? { href: "/safe" } : { title: name },
        children: [{ type: "text", value: name }],
      });
    }

    expect(parsePublicDocsRouteDataV1(input)).toEqual(input);
  });

  test("keeps the public node vocabulary pinned to the MDX runtime", () => {
    expect([...PUBLIC_RUNTIME_MDX_ELEMENT_NAMES].sort()).toEqual(
      [...RUNTIME_MDX_COMPONENT_NAMES, ...RUNTIME_MDX_INTRINSIC_NAMES].sort()
    );
  });

  test("keeps the icon vocabulary pinned to the docs icons", () => {
    expect([...PUBLIC_DOCS_ICON_ELEMENTS]).toEqual([...DOCS_ICON_ELEMENTS]);
    expect([...PUBLIC_DOCS_ICON_ATTRIBUTES]).toEqual([...DOCS_ICON_ATTRIBUTES]);
  });

  test("round-trips any Lucide icon name and the route's icon glyphs", () => {
    const input = createPageData();
    input.sectionNavigation = [
      { title: "Overview", href: "/overview", icon: "anchor" },
    ];
    input.icons = { anchor: CORE_ICON_NODES.zap! };

    expect(
      parsePublicDocsRouteDataV1(JSON.parse(JSON.stringify(input)))
    ).toEqual(input);
  });

  test.each([
    {
      label: "icon name that is not camelCase",
      mutate: (page: Record<string, unknown>) => {
        page.sectionNavigation = [
          { title: "Overview", href: "/overview", icon: "book-open" },
        ];
      },
    },
    {
      label: "icon glyph with a script element",
      mutate: (page: Record<string, unknown>) => {
        page.icons = { anchor: [["script", { d: "alert(1)" }]] };
      },
    },
    {
      label: "icon glyph with an event handler",
      mutate: (page: Record<string, unknown>) => {
        page.icons = { anchor: [["path", { d: "M0 0", onload: "x" }]] };
      },
    },
    {
      label: "empty icon glyph",
      mutate: (page: Record<string, unknown>) => {
        page.icons = { anchor: [] };
      },
    },
    {
      label: "unknown node",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, { type: "element", name: "Script" }),
    },
    {
      label: "unsafe URL",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "a",
          props: { href: "javascript:alert(1)" },
        }),
    },
    {
      label: "protocol-relative URL",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "a",
          props: { href: "//evil.example/path" },
        }),
    },
    {
      label: "non-finite number",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "Card",
          props: { columns: Number.POSITIVE_INFINITY },
        }),
    },
    {
      label: "private field",
      mutate: (page: Record<string, unknown>) => {
        page.secret = "token";
      },
    },
    {
      label: "raw HTML property",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "p",
          props: { dangerouslySetInnerHTML: { __html: "<img src=x>" } },
        }),
    },
    {
      label: "event handler property",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "p",
          props: { onClick: "alert(1)" },
        }),
    },
    {
      label: "lowercase event handler property",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "p",
          props: { onerror: "alert(1)" },
        }),
    },
    {
      label: "unsafe URL in a secondary URL property",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(page, {
          type: "element",
          name: "Card",
          props: { formAction: "javascript:alert(1)" },
        }),
    },
    {
      label: "prototype key",
      mutate: (page: Record<string, unknown>) =>
        setFirstNode(
          page,
          JSON.parse(
            '{"type":"element","name":"Card","props":{"__proto__":"x"}}'
          )
        ),
    },
  ])("rejects $label", ({ mutate }) => {
    const input = structuredClone(createPageData()) as unknown as Record<
      string,
      unknown
    >;
    mutate(input);
    expect(() => parsePublicDocsRouteDataV1(input)).toThrow();
  });

  test("rejects excessive node depth", () => {
    const input = createPageData();
    if (input.type !== "page" || !input.runtimeDocument?.ok)
      throw new Error("invalid fixture");
    let node: Record<string, unknown> = { type: "text", value: "end" };
    for (let depth = 0; depth < 65; depth += 1) {
      node = { type: "element", name: "span", children: [node] };
    }
    input.runtimeDocument.document.nodes = [node] as never;

    expect(() => parsePublicDocsRouteDataV1(input)).toThrow(/depth/i);
  });

  test("rejects payloads larger than the configured byte limit", () => {
    const input = createPageData();
    if (input.type !== "page" || !input.runtimeDocument?.ok)
      throw new Error("invalid fixture");
    input.runtimeDocument.document.nodes = [
      { type: "text", value: "x".repeat(2 * 1024 * 1024) },
    ];

    expect(() => parsePublicDocsRouteDataV1(input)).toThrow(/size/i);
  });

  test("validates endpoint response identity and strict fields", () => {
    expect(
      parsePublicRouteDataResponse({
        status: "ok",
        schemaVersion: 1,
        renderId: "a".repeat(64),
        data: createPageData(),
      })
    ).toMatchObject({ status: "ok", schemaVersion: 1 });
    expect(() =>
      parsePublicRouteDataResponse({
        status: "ok",
        schemaVersion: 1,
        renderId: "a".repeat(64),
        data: createPageData(),
        privateContext: true,
      })
    ).toThrow();
  });
});

function setFirstNode(page: Record<string, unknown>, node: unknown): void {
  const runtimeDocument = page.runtimeDocument as {
    document: { nodes: unknown[] };
  };
  runtimeDocument.document.nodes = [node];
}

function createPageData(): Extract<PublicDocsRouteDataV1, { type: "page" }> {
  return {
    type: "page",
    slug: "overview",
    href: "/overview",
    homeHref: "/overview",
    canonicalUrl: "https://docs.example.com/overview",
    site: {
      name: "Example",
      description: "Docs",
      url: "https://docs.example.com",
    },
    features: {
      branding: true,
      rightSidebar: true,
      feedbackEdit: false,
      tableOfContents: true,
      scrollToTop: true,
      ai: { chat: false, chatWithPage: false, floatingInput: false },
      copyPage: { markdown: true, rawText: true },
      apiPlayground: false,
      rawMarkdown: true,
      loadFromGithub: false,
    },
    sections: [{ slug: "default", label: "Docs", default: true }],
    visibleSections: [{ slug: "default", label: "Docs", default: true }],
    currentSection: { slug: "default", label: "Docs", default: true },
    sectionHomeHrefs: { default: "/overview" },
    sectionNavigation: [
      { heading: "Start" },
      { title: "Overview", href: "/overview" },
    ],
    sectionRoutes: [{ title: "Overview", href: "/overview" }],
    routeTitle: "Overview",
    sectionHeading: "Start",
    previous: null,
    next: null,
    document: {
      slug: "overview",
      href: "/overview",
      sourcePath: "overview/index.mdx",
      frontmatter: { title: "Overview", description: "Docs", keywords: "docs" },
      tocs: [{ level: 2, text: "Start", href: "#start" }],
      lastUpdated: null,
    },
    rawDoc: null,
    runtimeDocument: {
      ok: true,
      document: {
        frontmatter: { title: "Overview" },
        nodes: [
          {
            type: "element",
            name: "h1",
            children: [{ type: "text", value: "Overview" }],
          },
        ],
      },
    },
  };
}

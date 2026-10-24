import { describe, expect, test } from "vitest";

import { DocsContentError } from "../../src/services/docs-content/service";
import {
  applyStructureEdit,
  contentStructureFromArtifacts,
  restoreStructurePage,
  type ContentStructure,
} from "../../src/services/docs-content/structure";

describe("applyStructureEdit", () => {
  test("flattens legacy page children before deleting only the selected page", () => {
    const structure = contentStructureFromArtifacts(
      {
        pages: [
          { title: "Parent", href: "/parent", sourcePath: "source/parent/index.mdx" },
          { title: "Child", href: "/child", sourcePath: "source/child/index.mdx" },
        ],
      } as Parameters<typeof contentStructureFromArtifacts>[0],
      [{ slug: "default", label: "Docs", default: true }],
      new Map([
        [
          "default",
          [
            { heading: "Guides" },
            {
              title: "Parent",
              href: "/parent",
              items: [{ title: "Child", href: "/child" }],
            },
          ],
        ],
      ]),
    );

    expect(structure.sections[0]?.nodes).toEqual([
      { heading: "Guides" },
      { title: "Parent", href: "/parent" },
      { title: "Child", href: "/child" },
    ]);

    const result = applyStructureEdit(structure, {
      type: "delete_page",
      href: "/parent",
    });

    expect(result.structure.pages.map((page) => page.href)).toEqual(["/child"]);
    expect(pageHrefs(result.structure.sections[0]?.nodes ?? [])).toEqual(["/child"]);
    expect(result.bodyWrites).toEqual([{ type: "remove", href: "/parent" }]);
  });

  test("creates a section with one sample page", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "create_section",
      slug: "sdk",
      label: "SDK",
    });

    const section = result.structure.sections.at(-1);
    expect(section).toMatchObject({ slug: "sdk", label: "SDK", default: false });
    expect(pageHrefs(section?.nodes ?? [])).toEqual(["/sdk"]);
    expect(result.structure.pages.at(-1)).toEqual({
      title: "New Page",
      href: "/sdk",
      sourcePath: "source/sdk/index.mdx",
    });
    expect(result.bodyWrites).toEqual([
      {
        type: "create",
        href: "/sdk",
        content: "---\ntitle: New Page\ndescription: \"\"\n---\n\nNew Page!\n",
      },
    ]);
  });

  test("rejects a section slug that would capture a default-section page", () => {
    expect(() =>
      applyStructureEdit(createStructure(), {
        type: "create_section",
        slug: "guide",
        label: "Guide",
      }),
    ).toThrowError(new DocsContentError(
      "invalid",
      "The section slug guide conflicts with an existing page path.",
    ));
  });

  test("renames a section without changing its slug or metadata", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "rename_section",
      slug: "api",
      label: "REST API",
    });

    expect(result.structure.sections[1]).toMatchObject({
      slug: "api",
      label: "REST API",
      attributes: { layout: "reference" },
    });
    expect(result.bodyWrites).toEqual([]);
  });

  test("creates an empty group with no placeholder page", () => {
    const structure = createStructure();
    const result = applyStructureEdit(structure, {
      type: "create_group",
      sectionSlug: "default",
      heading: "Examples",
    });

    expect(result.structure.sections[0]?.nodes.at(-1)).toEqual({ heading: "Examples" });
    expect(result.structure.pages).toEqual(structure.pages);
    expect(result.bodyWrites).toEqual([]);
  });

  test("creates a group with one starter page when asked", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "create_group",
      sectionSlug: "default",
      heading: "Examples",
      starterPage: true,
    });

    const section = result.structure.sections[0];
    expect(section?.nodes.slice(-2)).toEqual([
      { heading: "Examples" },
      { title: "New Page", href: "/new-page" },
    ]);
    expect(result.bodyWrites).toHaveLength(1);
    expect(result.bodyWrites[0]).toMatchObject({ type: "create", href: "/new-page" });
  });

  test("puts the next page of the same edit list into a new empty group", () => {
    let structure = applyStructureEdit(createStructure(), {
      type: "create_group",
      sectionSlug: "default",
      heading: "Examples",
    }).structure;
    const result = applyStructureEdit(structure, {
      type: "create_page",
      sectionSlug: "default",
      groupIndex: 2,
      title: "Hello",
      slug: "hello",
    });
    structure = result.structure;

    expect(structure.sections[0]?.nodes.slice(-2)).toEqual([
      { heading: "Examples" },
      { title: "Hello", href: "/hello" },
    ]);
    expect(result.bodyWrites).toEqual([
      expect.objectContaining({ type: "create", href: "/hello" }),
    ]);
  });

  test("keeps a new empty group when a page elsewhere is deleted", () => {
    let structure = applyStructureEdit(createStructure(), {
      type: "create_group",
      sectionSlug: "default",
      heading: "Examples",
    }).structure;
    structure = applyStructureEdit(structure, {
      type: "delete_page",
      href: "/advanced",
    }).structure;
    structure = applyStructureEdit(structure, {
      type: "delete_group",
      sectionSlug: "default",
      groupIndex: 0,
    }).structure;

    expect(structure.sections[0]?.nodes).toEqual([
      { title: "Overview", href: "/", icon: "compass" },
      { heading: "Examples" },
    ]);
  });

  test("renames the heading at its artifact group index", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "rename_group",
      sectionSlug: "default",
      groupIndex: 1,
      heading: "Deep dives",
    });

    expect(result.structure.sections[0]?.nodes).toContainEqual({ heading: "Deep dives" });
    expect(result.structure.sections[0]?.nodes).not.toContainEqual({ heading: "Advanced" });
  });

  test("creates a page at the end of the selected group", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "create_page",
      sectionSlug: "default",
      groupIndex: 0,
      title: "Install",
      slug: "install",
    });

    expect(result.structure.sections[0]?.nodes).toEqual([
      { title: "Overview", href: "/", icon: "compass" },
      { heading: "Guides" },
      { title: "Guide", href: "/guide" },
      { title: "Install", href: "/install" },
      { heading: "Advanced" },
      { title: "Advanced", href: "/advanced" },
    ]);
    expect(result.bodyWrites[0]).toMatchObject({ type: "create", href: "/install" });
  });

  test("rejects a page whose effective href already exists", () => {
    expect(() =>
      applyStructureEdit(createStructure(), {
        type: "create_page",
        sectionSlug: "api",
        groupIndex: 0,
        title: "Flags again",
        slug: "flags",
      }),
    ).toThrowError("A page already exists at /api/flags.");
  });

  test("renames a page and requests a title-aware body copy", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "rename_page",
      href: "/guide",
      title: "Getting Started",
      slug: "getting-started",
    });

    expect(result.structure.pages).toContainEqual({
      title: "Getting Started",
      href: "/getting-started",
      sourcePath: "source/getting-started/index.mdx",
    });
    expect(result.structure.pages.some((page) => page.href === "/guide")).toBe(false);
    expect(pageHrefs(result.structure.sections[0]?.nodes ?? [])).toContain(
      "/getting-started",
    );
    expect(result.bodyWrites).toEqual([
      {
        type: "copy",
        fromHref: "/guide",
        toHref: "/getting-started",
        title: "Getting Started",
      },
    ]);
  });

  test("reorders sections before another section", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "move_section",
      slug: "api",
      beforeSlug: "default",
    });

    expect(result.structure.sections.map((section) => section.slug)).toEqual([
      "api",
      "default",
    ]);
  });

  test("moves a group across sections and rewrites every page href", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "move_group",
      sectionSlug: "default",
      groupIndex: 0,
      toSectionSlug: "api",
      beforeGroupIndex: 0,
    });

    expect(pageHrefs(result.structure.sections[0]?.nodes ?? [])).not.toContain("/guide");
    expect(result.structure.sections[1]?.nodes.slice(0, 2)).toEqual([
      { heading: "Guides" },
      { title: "Guide", href: "/api/guide" },
    ]);
    expect(result.bodyWrites).toContainEqual({
      type: "copy",
      fromHref: "/guide",
      toHref: "/api/guide",
      title: "Guide",
    });
  });

  test("flattens a legacy container before inserting a group", () => {
    const structure = createStructure();
    structure.pages.push({
      title: "Nested",
      href: "/api/nested",
      sourcePath: "source/api/nested/index.mdx",
    });
    structure.sections[1]?.nodes.push({
      title: "Container",
      href: "/api",
      items: [
        { heading: "Nested group" },
        { title: "Nested", href: "/api/nested" },
      ],
    });

    const result = applyStructureEdit(structure, {
      type: "move_group",
      sectionSlug: "default",
      groupIndex: 0,
      toSectionSlug: "api",
      beforeGroupIndex: 1,
    });

    expect(result.structure.sections[1]?.nodes.slice(-5)).toEqual([
      { title: "Container", href: "/api" },
      { heading: "Guides" },
      { title: "Guide", href: "/api/guide" },
      { heading: "Nested group" },
      { title: "Nested", href: "/api/nested" },
    ]);
  });

  test("moves a page between groups in one section without changing its href", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "move_page",
      href: "/advanced",
      toSectionSlug: "default",
      toGroupIndex: 0,
      beforeHref: "/guide",
    });

    expect(result.structure.sections[0]?.nodes.slice(0, 5)).toEqual([
      { title: "Overview", href: "/", icon: "compass" },
      { heading: "Guides" },
      { title: "Advanced", href: "/advanced" },
      { title: "Guide", href: "/guide" },
      { heading: "Advanced" },
    ]);
    expect(result.bodyWrites).toEqual([]);
  });

  test("adds the target prefix when a page moves to another section", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "move_page",
      href: "/guide",
      toSectionSlug: "api",
      toGroupIndex: 0,
      beforeHref: "/api/flags",
    });

    expect(result.structure.pages.some((page) => page.href === "/api/guide")).toBe(true);
    expect(result.bodyWrites).toContainEqual({
      type: "copy",
      fromHref: "/guide",
      toHref: "/api/guide",
      title: "Guide",
    });
  });

  test("drops the source prefix when a page moves to the default section", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "move_page",
      href: "/api/flags",
      toSectionSlug: "default",
      toGroupIndex: 1,
      beforeHref: null,
    });

    expect(result.structure.pages.some((page) => page.href === "/flags")).toBe(true);
    expect(result.bodyWrites).toContainEqual({
      type: "copy",
      fromHref: "/api/flags",
      toHref: "/flags",
      title: "Flags",
    });
  });

  test.each([
    {
      type: "rename_section" as const,
      slug: "missing",
      label: "Missing",
    },
    {
      type: "rename_group" as const,
      sectionSlug: "default",
      groupIndex: 9,
      heading: "Missing",
    },
    {
      type: "move_page" as const,
      href: "/missing",
      toSectionSlug: "default",
      toGroupIndex: null,
      beforeHref: null,
    },
  ])("rejects an edit whose target does not exist: $type", (edit) => {
    expect(() => applyStructureEdit(createStructure(), edit)).toThrowError(
      DocsContentError,
    );
  });

  test("deletes a section with every page inside it", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "delete_section",
      slug: "api",
    });

    expect(result.structure.sections.map((section) => section.slug)).toEqual(["default"]);
    expect(result.structure.pages.map((page) => page.href)).toEqual([
      "/",
      "/guide",
      "/advanced",
    ]);
    expect(result.bodyWrites).toEqual([
      { type: "remove", href: "/api" },
      { type: "remove", href: "/api/flags" },
    ]);
  });

  test("refuses to delete the default section", () => {
    // The default section owns the root of the site. Without it the renderer
    // has no landing page and no section marked default.
    expect(() =>
      applyStructureEdit(createStructure(), { type: "delete_section", slug: "default" }),
    ).toThrow(DocsContentError);
  });

  test("deletes a group with every page inside it", () => {
    const result = applyStructureEdit(createStructure(), {
      type: "delete_group",
      sectionSlug: "default",
      groupIndex: 0,
    });

    const section = result.structure.sections[0];
    expect(pageHrefs(section.nodes)).toEqual(["/", "/advanced"]);
    expect(section.nodes.some((node) => isRecord(node) && node.heading === "Guides")).toBe(false);
    expect(result.structure.pages.map((page) => page.href)).not.toContain("/guide");
    expect(result.bodyWrites).toEqual([{ type: "remove", href: "/guide" }]);
  });

  test("drops the heading a page delete leaves empty", () => {
    // A delete takes the group it empties with it.
    const result = applyStructureEdit(createStructure(), {
      type: "delete_page",
      href: "/guide",
    });

    const section = result.structure.sections[0];
    expect(section.nodes.some((node) => isRecord(node) && node.heading === "Guides")).toBe(false);
    expect(section.nodes.some((node) => isRecord(node) && node.heading === "Advanced")).toBe(true);
  });

  test("flattens legacy nested headings before it prunes an empty group", () => {
    const structure = contentStructureFromArtifacts(
      {
        pages: [
          { title: "Home", href: "/", sourcePath: "source/index.mdx" },
          { title: "Drop", href: "/drop", sourcePath: "source/drop/index.mdx" },
          { title: "Keep", href: "/keep", sourcePath: "source/keep/index.mdx" },
        ],
      } as Parameters<typeof contentStructureFromArtifacts>[0],
      [{ slug: "default", label: "Docs", default: true }],
      new Map([
        [
          "default",
          [
            {
              title: "Home",
              href: "/",
              items: [
                { heading: "Empty soon" },
                { title: "Drop", href: "/drop" },
                { heading: "Still used" },
                { title: "Keep", href: "/keep" },
              ],
            },
          ],
        ],
      ]),
    );

    const result = applyStructureEdit(structure, {
      type: "delete_page",
      href: "/drop",
    });

    expect(result.structure.sections[0]?.nodes).toEqual([
      { title: "Home", href: "/" },
      { heading: "Still used" },
      { title: "Keep", href: "/keep" },
    ]);
  });

  test("drops a non-default section its last page delete leaves empty", () => {
    let structure = applyStructureEdit(createStructure(), {
      type: "delete_page",
      href: "/api",
    }).structure;
    structure = applyStructureEdit(structure, { type: "delete_page", href: "/api/flags" }).structure;

    expect(structure.sections.map((section) => section.slug)).toEqual(["default"]);
  });

  test("keeps the default section when its last group goes", () => {
    let structure = applyStructureEdit(createStructure(), {
      type: "delete_group",
      sectionSlug: "default",
      groupIndex: 0,
    }).structure;
    structure = applyStructureEdit(structure, {
      type: "delete_group",
      sectionSlug: "default",
      groupIndex: 0,
    }).structure;

    expect(structure.sections.map((section) => section.slug)).toEqual(["default", "api"]);
    expect(pageHrefs(structure.sections[0].nodes)).toEqual(["/"]);
  });

  test("refuses a delete that would leave no page at all", () => {
    let structure = applyStructureEdit(createStructure(), {
      type: "delete_section",
      slug: "api",
    }).structure;
    structure = applyStructureEdit(structure, {
      type: "delete_group",
      sectionSlug: "default",
      groupIndex: 0,
    }).structure;
    structure = applyStructureEdit(structure, {
      type: "delete_group",
      sectionSlug: "default",
      groupIndex: 0,
    }).structure;

    expect(() =>
      applyStructureEdit(structure, { type: "delete_page", href: "/" }),
    ).toThrow(DocsContentError);
  });

  test("refuses to delete a page that does not exist", () => {
    expect(() =>
      applyStructureEdit(createStructure(), { type: "delete_page", href: "/missing" }),
    ).toThrow(DocsContentError);
  });
});

describe("restoreStructurePage", () => {
  /** A REST reference section as a generation writes it: each group in its own order. */
  function generatedReference(): ContentStructure {
    const nodes: Array<{ heading: string } | { title: string; href: string }> = [
      { heading: "Service" },
      { title: "Service", href: "/rest/service" },
      { title: "Check health", href: "/rest/get-health" },
      { title: "Get OpenAPI", href: "/rest/get-openapi" },
      { heading: "Projects" },
      { title: "Projects", href: "/rest/projects" },
      { title: "Create project", href: "/rest/post-projects" },
      { title: "List projects", href: "/rest/get-projects" },
      { heading: "Audit logs" },
      { title: "Audit logs", href: "/rest/audit-logs" },
    ]
    return {
      pages: [
        { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
        ...nodes.flatMap((node) => ("href" in node ? [{ title: node.title, href: node.href, sourcePath: `source${node.href}/index.mdx` }] : [])),
      ],
      sections: [
        { slug: "default", label: "Docs", default: true, attributes: {}, nodes: [{ title: "Overview", href: "/" }] },
        { slug: "rest", label: "REST API", default: false, attributes: {}, nodes },
      ],
    }
  }

  function withoutRest(structure: ContentStructure): ContentStructure {
    return {
      pages: structure.pages.filter((page) => !page.href.startsWith("/rest")),
      sections: structure.sections.filter((section) => section.slug !== "rest"),
    }
  }

  const navigationOf = (structure: ContentStructure, slug: string) =>
    (structure.sections.find((section) => section.slug === slug)?.nodes ?? []).map((node) =>
      isRecord(node) && typeof node.heading === "string" ? `# ${node.heading}` : isRecord(node) ? String(node.href) : "",
    )

  test("rebuilds the source order when pages come back one by one in route order", () => {
    const source = generatedReference()
    const routeOrder = source.pages.map((page) => page.href).filter((href) => href.startsWith("/rest")).sort()

    const restored = routeOrder.reduce((structure, href) => restoreStructurePage(structure, source, href), withoutRest(source))

    expect(navigationOf(restored, "rest")).toEqual(navigationOf(source, "rest"))
  })

  test("puts a page back between its neighbors, after a page that a person added", () => {
    const source = generatedReference()
    const target = restoreStructurePage(
      restoreStructurePage(restoreStructurePage(withoutRest(source), source, "/rest/service"), source, "/rest/get-openapi"),
      source,
      "/rest/projects",
    )
    target.sections[1]?.nodes.splice(2, 0, { title: "Rate limits", href: "/rest/rate-limits" })
    target.pages.push({ title: "Rate limits", href: "/rest/rate-limits", sourcePath: "source/rest/rate-limits/index.mdx" })

    const restored = restoreStructurePage(target, source, "/rest/get-health")

    expect(navigationOf(restored, "rest")).toEqual([
      "# Service",
      "/rest/service",
      "/rest/get-health",
      "/rest/rate-limits",
      "/rest/get-openapi",
      "# Projects",
      "/rest/projects",
    ])
  })

  test("does not follow a neighbor that a person moved to another group", () => {
    const source = generatedReference()
    const target = restoreStructurePage(withoutRest(source), source, "/rest/projects")
    const nodes = target.sections[1]?.nodes ?? []
    nodes.push({ heading: "Other" }, { title: "Service", href: "/rest/service" })
    target.pages.push({ title: "Service", href: "/rest/service", sourcePath: "source/rest/service/index.mdx" })

    const restored = restoreStructurePage(target, source, "/rest/get-health")

    expect(navigationOf(restored, "rest")).toEqual([
      "# Service",
      "/rest/get-health",
      "# Projects",
      "/rest/projects",
      "# Other",
      "/rest/service",
    ])
  })
})

function createStructure(): ContentStructure {
  return {
    pages: [
      { title: "Overview", href: "/", sourcePath: "source/index.mdx" },
      { title: "Guide", href: "/guide", sourcePath: "source/guide/index.mdx" },
      { title: "Advanced", href: "/advanced", sourcePath: "source/advanced/index.mdx" },
      { title: "API", href: "/api", sourcePath: "source/api/index.mdx" },
      { title: "Flags", href: "/api/flags", sourcePath: "source/api/flags/index.mdx" },
    ],
    sections: [
      {
        slug: "default",
        label: "Docs",
        default: true,
        attributes: { kind: "documentation" },
        nodes: [
          { title: "Overview", href: "/", icon: "compass" },
          { heading: "Guides" },
          { title: "Guide", href: "/guide" },
          { heading: "Advanced" },
          { title: "Advanced", href: "/advanced" },
        ],
      },
      {
        slug: "api",
        label: "API Reference",
        default: false,
        attributes: { layout: "reference" },
        nodes: [
          { heading: "Endpoints" },
          { title: "API", href: "/api" },
          { title: "Flags", href: "/api/flags" },
        ],
      },
    ],
  };
}

function pageHrefs(nodes: readonly unknown[]): string[] {
  const hrefs: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.href === "string") hrefs.push(node.href);
    if (Array.isArray(node.items)) hrefs.push(...pageHrefs(node.items));
  }
  return hrefs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

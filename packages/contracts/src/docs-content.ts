import { z } from "zod";
import { siteConfigSchema } from "@doxahq/site-config";
import { projectEntitlementsSchema } from "./entitlements";

/**
 * Contracts for the dashboard docs content editor.
 *
 * The editor never writes a published version directly. It writes a branch,
 * which is a sparse overlay on one published version. Every mutation goes
 * through one edit list, so the HTTP routes, a future in-dashboard AI agent, and
 * a future MCP server all share the same operation set and the same validation.
 */

/** Upper bound for one page source. Large enough for any real page. */
export const DOCS_CONTENT_MAX_PAGE_BYTES = 512 * 1024;

export const docsContentPageStatusSchema = z.enum(["published", "edited"]);

export const docsContentEditOriginSchema = z.enum(["editor", "agent", "mcp"]);

export const docsContentPageSchema = z
  .object({
    href: z.string().min(1),
    title: z.string(),
    sourcePath: z.string().min(1),
    status: docsContentPageStatusSchema,
    /**
     * Icon name from the published navigation, drawn beside the page in the
     * editor the same way the docs sidebar draws it. Null when the navigation
     * carries no icon for this page.
     */
    icon: z.string().min(1).nullable(),
  })
  .strict();

export const docsContentNavigationGroupSchema = z
  .object({
    /** The group heading, or null for pages that sit above the first heading. */
    heading: z.string().min(1).nullable(),
    /**
     * Position of the heading in the navigation artifact, from zero.
     *
     * Null identifies pages that sit above the first heading.
     */
    groupIndex: z.number().int().nonnegative().nullable(),
    /** Page hrefs, in published navigation order. */
    hrefs: z.array(z.string().min(1)),
  })
  .strict();

export const docsContentNavigationSectionSchema = z
  .object({
    slug: z.string().min(1),
    label: z.string().min(1),
    /** True for the section that owns the documentation root. */
    isDefault: z.boolean(),
    groups: z.array(docsContentNavigationGroupSchema),
  })
  .strict();

export const docsContentWorkingSchema = z
  .object({
    branchId: z.uuid().nullable(),
    baseVersionId: z.uuid(),
    editedHrefs: z.array(z.string().min(1)),
    changeCount: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
    /**
     * False when the site published a new version after this branch started.
     */
    isBaseCurrent: z.boolean(),
  })
  .strict();

export const docsContentVersionSchema = z
  .object({
    id: z.string().min(1),
    versionNumber: z.number().int().positive(),
    createdAt: z.string().min(1),
  })
  .strict();

export const docsContentOverviewSchema = z
  .object({
    projectId: z.string().min(1),
    projectSlug: z.string().min(1),
    siteId: z.string().min(1),
    publishedVersion: docsContentVersionSchema,
    working: docsContentWorkingSchema,
    entitlements: projectEntitlementsSchema,
    siteConfig: z
      .object({
        published: siteConfigSchema,
        working: siteConfigSchema.nullable(),
      })
      .strict(),
    pages: z.array(docsContentPageSchema),
    /**
     * How the published site arranges its pages. Ordering metadata only: every
     * href here also appears in `pages`. A page missing from this tree is still
     * editable, and the editor lists it after the last section.
     */
    navigation: z.array(docsContentNavigationSectionSchema),
  })
  .strict();

export const docsContentPageDetailSchema = z
  .object({
    href: z.string().min(1),
    title: z.string(),
    sourcePath: z.string().min(1),
    status: docsContentPageStatusSchema,
    /** The source as published. Kept so a later version can render a diff. */
    publishedContent: z.string(),
    /** The branch source, or null when this page has no working change. */
    workingContent: z.string().nullable(),
  })
  .strict();

/**
 * One problem that the renderer's MDX parser found in a page source. The line
 * counts from the top of the file, frontmatter included. Null when the parser
 * gave no position.
 */
export const docsMdxIssueSchema = z
  .object({
    line: z.number().int().positive().nullable(),
    column: z.number().int().positive().nullable(),
    /** The parser's reason, without the position. */
    message: z.string().min(1),
  })
  .strict();

/** A changed page whose source fails the MDX check. */
export const docsPageMdxIssuesSchema = z
  .object({
    href: z.string().min(1),
    sourcePath: z.string().min(1),
    issues: z.array(docsMdxIssueSchema).min(1),
  })
  .strict();

/**
 * The changed pages of a branch that fail the MDX check, in source path
 * order. A publish is blocked while this list has an entry.
 */
export const docsContentMdxReportSchema = z
  .object({ pages: z.array(docsPageMdxIssuesSchema) })
  .strict();

/** Matches the section slug rule that the docs renderer enforces. */
export const DOCS_SECTION_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Matches one or more renderer-compatible page path segments. */
export const DOCS_PAGE_SLUG_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

const structureNameSchema = z.string().trim().min(1).max(120);
const sectionSlugSchema = z.string().trim().regex(DOCS_SECTION_SLUG_PATTERN);
const pageSlugSchema = z.string().trim().regex(DOCS_PAGE_SLUG_PATTERN);
const groupIndexSchema = z.number().int().nonnegative();
/**
 * A page icon name from the shared docs icon vocabulary (`DOCS_ICON_NAMES` in
 * `@doxahq/docs-prose`). The contract checks the name shape only. A renderer
 * draws no icon for a name it does not know.
 */
export const DOCS_PAGE_ICON_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;
const pageIconSchema = z.string().regex(DOCS_PAGE_ICON_PATTERN);

/**
 * Adds a group heading at the end of a section. The group starts empty, and
 * a `create_page` with its group index fills it, in the same edit list or a
 * later one. `starterPage` also creates a "New Page" inside it, for the
 * dashboard, which opens that page right after the group appears.
 */
export const docsContentCreateGroupEditSchema = z
  .object({
    type: z.literal("create_group"),
    sectionSlug: sectionSlugSchema,
    heading: structureNameSchema,
    starterPage: z.boolean().optional(),
  })
  .strict();

/**
 * One content mutation. New operations (create, delete, rename, frontmatter
 * patches) join this union without changing any route or client call site.
 */
export const docsContentEditSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("set_site_config"), config: siteConfigSchema })
    .strict(),
  z.object({ type: z.literal("reset_site_config") }).strict(),
  /**
   * Sets the page that the site root shows (`homePage` in the site config).
   * Null removes the choice: the root then shows the first page of the
   * default section.
   */
  z
    .object({
      type: z.literal("set_home_page"),
      href: z.string().trim().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_page_content"),
      href: z.string().min(1),
      content: z.string().max(DOCS_CONTENT_MAX_PAGE_BYTES),
    })
    .strict(),
  z
    .object({
      type: z.literal("reset_page"),
      href: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("create_section"),
      slug: sectionSlugSchema,
      label: structureNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("rename_section"),
      slug: sectionSlugSchema,
      label: structureNameSchema,
    })
    .strict(),
  docsContentCreateGroupEditSchema,
  z
    .object({
      type: z.literal("rename_group"),
      sectionSlug: sectionSlugSchema,
      groupIndex: groupIndexSchema,
      heading: structureNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("create_page"),
      sectionSlug: sectionSlugSchema,
      groupIndex: groupIndexSchema.nullable(),
      title: structureNameSchema,
      slug: pageSlugSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("rename_page"),
      href: z.string().trim().min(1),
      title: structureNameSchema,
      slug: pageSlugSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_page_icon"),
      href: z.string().trim().min(1),
      /** Null removes the icon. */
      icon: pageIconSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move_section"),
      slug: sectionSlugSchema,
      beforeSlug: sectionSlugSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move_group"),
      sectionSlug: sectionSlugSchema,
      groupIndex: groupIndexSchema,
      toSectionSlug: sectionSlugSchema,
      beforeGroupIndex: groupIndexSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move_page"),
      href: z.string().trim().min(1),
      toSectionSlug: sectionSlugSchema,
      toGroupIndex: groupIndexSchema.nullable(),
      beforeHref: z.string().trim().min(1).nullable(),
    })
    .strict(),
  /**
   * Deletes a section with every group and page it holds.
   *
   * The renderer requires exactly one default section, so the default section
   * cannot be deleted.
   */
  z
    .object({
      type: z.literal("delete_section"),
      slug: sectionSlugSchema,
    })
    .strict(),
  /** Deletes a group with every page it holds. */
  z
    .object({
      type: z.literal("delete_group"),
      sectionSlug: sectionSlugSchema,
      groupIndex: groupIndexSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("delete_page"),
      href: z.string().trim().min(1),
    })
    .strict(),
]);

/**
 * Body of `POST /projects/:id/content/edits`. The body carries no origin: the
 * server sets it from the caller, so a client cannot claim another origin.
 */
export const applyDocsContentEditsInputSchema = z
  .object({
    branch: z.union([z.literal("main"), z.uuid()]),
    edits: z.array(docsContentEditSchema).min(1).max(100),
  })
  .strict();

/**
 * Response of `POST /projects/:id/content/edits`. A dashboard save succeeds
 * even when a page fails the MDX check: `mdxIssues` lists the pages of this
 * save that fail it, so the editor can show them.
 */
export const applyDocsContentEditsResultSchema = z
  .object({
    working: docsContentWorkingSchema,
    mdxIssues: z.array(docsPageMdxIssuesSchema),
  })
  .strict();

export type DocsContentPageStatus =z.infer<typeof docsContentPageStatusSchema>;
export type DocsContentEditOrigin = z.infer<typeof docsContentEditOriginSchema>;
export type DocsContentPageDto = z.infer<typeof docsContentPageSchema>;
export type DocsContentNavigationGroupDto = z.infer<
  typeof docsContentNavigationGroupSchema
>;
export type DocsContentNavigationSectionDto = z.infer<
  typeof docsContentNavigationSectionSchema
>;
export type DocsContentWorkingDto = z.infer<typeof docsContentWorkingSchema>;
export type DocsContentVersionDto = z.infer<typeof docsContentVersionSchema>;
export type DocsContentOverviewDto = z.infer<typeof docsContentOverviewSchema>;
export type DocsContentPageDetailDto = z.infer<
  typeof docsContentPageDetailSchema
>;
export type DocsContentEdit = z.input<typeof docsContentEditSchema>;
export type ApplyDocsContentEditsInput = z.input<
  typeof applyDocsContentEditsInputSchema
>;
export type ApplyDocsContentEditsResult = z.infer<
  typeof applyDocsContentEditsResultSchema
>;
export type DocsMdxIssue = z.infer<typeof docsMdxIssueSchema>;
export type DocsPageMdxIssues = z.infer<typeof docsPageMdxIssuesSchema>;
export type DocsContentMdxReport = z.infer<typeof docsContentMdxReportSchema>;

import { z } from "zod";

export const DOCS_PRERENDER_SCHEMA_VERSION = 1 as const;

export const DOCS_PRERENDER_LIMITS = {
  concurrentRoutes: 4,
  htmlBytes: 2 * 1024 * 1024,
  jsonBytes: 2 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024,
  manifestRoutes: 2_000,
  decodedPathnameCharacters: 2_048,
  jsonDepth: 64,
  jsonNodes: 50_000,
  jsonArrayItems: 50_000,
  jsonObjectKeys: 20_000,
  lookupDeadlineMs: 1_500,
  liveFallbackTtlSeconds: 30,
  repairCooldownSeconds: 60,
} as const;

export const sha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const safeIdentitySegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const localHrefSchema = z
  .string()
  .min(1)
  .max(DOCS_PRERENDER_LIMITS.decodedPathnameCharacters)
  .refine((value) => {
    try {
      return normalizePublicDocsPathname(value) === value;
    } catch {
      return false;
    }
  }, "Expected a normalized local route");
const publicUrlSchema = z
  .url()
  .refine((value) => /^https?:/i.test(value), "Expected an HTTP(S) URL");
const finiteNumberSchema = z.number().finite();
/**
 * A page or card icon name: any Lucide icon in camelCase. The shape matches
 * `DOCS_PAGE_ICON_PATTERN` in `./docs-content` and `DOCS_ICON_NAME_PATTERN`
 * in `@doxahq/docs-prose`. A renderer draws no icon for a name it does not
 * know, so the contract checks the shape only.
 */
const docsIconNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/);
type DocsIconName = z.infer<typeof docsIconNameSchema>;

// This browser-safe schema intentionally owns no MDX parser dependency. The
// docs-template drift test pins this list to @doxahq/mdx-runtime exports.
export const PUBLIC_RUNTIME_MDX_ELEMENT_NAMES = [
  "a",
  "ApiEndpoint",
  "ApiParam",
  "ApiParams",
  "ApiRequestExample",
  "ApiResponseExample",
  "blockquote",
  "br",
  "Card",
  "CardGrid",
  "code",
  "Embed",
  "em",
  "File",
  "FileTree",
  "Folder",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "Mermaid",
  "Note",
  "ol",
  "p",
  "pre",
  "span",
  "Step",
  "StepItem",
  "strong",
  "table",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

const mdxPropValueSchema: z.ZodType<
  string | number | boolean | Record<string, string>
> = z.union([
  z.string(),
  finiteNumberSchema,
  z.boolean(),
  z.record(z.string(), z.string()),
]);

type PublicRuntimeMdxNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      name: (typeof PUBLIC_RUNTIME_MDX_ELEMENT_NAMES)[number];
      props?: Record<
        string,
        string | number | boolean | Record<string, string>
      >;
      children?: PublicRuntimeMdxNode[];
    };

const publicRuntimeMdxNodeSchema: z.ZodType<PublicRuntimeMdxNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), value: z.string() }).strict(),
    z
      .object({
        type: z.literal("element"),
        name: z.enum(PUBLIC_RUNTIME_MDX_ELEMENT_NAMES),
        props: z.record(z.string(), mdxPropValueSchema).optional(),
        children: z.array(publicRuntimeMdxNodeSchema).optional(),
      })
      .strict(),
  ]),
);

const runtimeMdxFrontmatterSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    apiMethod: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .optional(),
    apiPath: z.string().optional(),
  })
  .strict();

const parsedDocumentSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      document: z
        .object({
          frontmatter: runtimeMdxFrontmatterSchema,
          nodes: z.array(publicRuntimeMdxNodeSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.literal("MDX_RUNTIME_PARSE_FAILED"),
      error: z.string(),
    })
    .strict(),
]);

const featureConfigSchema = z
  .object({
    branding: z.boolean(),
    rightSidebar: z.boolean(),
    feedbackEdit: z.boolean(),
    tableOfContents: z.boolean(),
    scrollToTop: z.boolean(),
    ai: z
      .object({
        chat: z.boolean(),
        chatWithPage: z.boolean(),
        floatingInput: z.boolean(),
      })
      .strict(),
    copyPage: z
      .object({ markdown: z.boolean(), rawText: z.boolean() })
      .strict(),
    apiPlayground: z.boolean(),
    apiPlaygroundBaseUrl: z.string().optional(),
    rawMarkdown: z.boolean(),
    loadFromGithub: z.boolean(),
  })
  .strict();

const sectionSchema = z
  .object({
    slug: z.string(),
    label: z.string(),
    description: z.string().optional(),
    icon: docsIconNameSchema.optional(),
    default: z.boolean().optional(),
    hidden: z.boolean().optional(),
    kind: z.enum(["documentation", "reference", "development"]).optional(),
    layout: z.enum(["docs", "reference"]).optional(),
  })
  .strict();

type PublicNavNode =
  | {
      title: string;
      href: string;
      icon?: DocsIconName;
      badge?: string;
      noLink?: true;
      heading?: string;
      items?: PublicNavNode[];
    }
  | { heading: string }
  | { spacer: true };

const navNodeSchema: z.ZodType<PublicNavNode> = z.lazy(() =>
  z.union([
    z
      .object({
        title: z.string(),
        href: localHrefSchema,
        icon: docsIconNameSchema.optional(),
        badge: z.string().optional(),
        noLink: z.literal(true).optional(),
        heading: z.string().optional(),
        items: z.array(navNodeSchema).optional(),
      })
      .strict(),
    z.object({ heading: z.string() }).strict(),
    z.object({ spacer: z.literal(true) }).strict(),
  ]),
);

const navPageSchema = z
  .object({
    title: z.string(),
    href: localHrefSchema,
    icon: docsIconNameSchema.optional(),
    badge: z.string().optional(),
    noLink: z.literal(true).optional(),
    heading: z.string().optional(),
    items: z.array(navNodeSchema).optional(),
  })
  .strict();

// Keep these lists in step with `DOCS_ICON_ELEMENTS` and
// `DOCS_ICON_ATTRIBUTES` in `@doxahq/docs-prose`. The docs-template drift test
// pins them.
export const PUBLIC_DOCS_ICON_ELEMENTS = [
  "path",
  "circle",
  "rect",
  "line",
  "ellipse",
  "polyline",
  "polygon",
] as const;
export const PUBLIC_DOCS_ICON_ATTRIBUTES = [
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "points",
  "fill",
] as const;

const iconNodeSchema = z
  .array(
    z
      .tuple([
        z.enum(PUBLIC_DOCS_ICON_ELEMENTS),
        z.partialRecord(
          z.enum(PUBLIC_DOCS_ICON_ATTRIBUTES),
          z.string().max(4_096),
        ),
      ])
      .readonly(),
  )
  .min(1)
  .max(64)
  .readonly();

/**
 * The glyphs of the icons that a route draws and that the renderer does not
 * bundle, by the name the route uses. Optional: a route that uses only the
 * bundled icons has none.
 */
const routeIconsSchema = z
  .record(docsIconNameSchema, iconNodeSchema)
  .refine((icons) => Object.keys(icons).length <= 512, "Too many route icons");

const routeDocumentSchema = z
  .object({
    slug: z.string(),
    href: localHrefSchema,
    sourcePath: z.string().min(1),
    frontmatter: z
      .object({
        title: z.string(),
        description: z.string(),
        keywords: z.string(),
        apiMethod: z.string().optional(),
        apiPath: z.string().optional(),
      })
      .strict(),
    tocs: z.array(
      z
        .object({
          level: z.number().int().min(1).max(6),
          text: z.string(),
          href: z.string(),
        })
        .strict(),
    ),
    lastUpdated: z.null(),
  })
  .strict();

const pageDataFields = {
  slug: z.string(),
  href: localHrefSchema,
  homeHref: localHrefSchema.nullable(),
  canonicalUrl: publicUrlSchema,
  site: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      url: publicUrlSchema,
    })
    .strict(),
  features: featureConfigSchema,
  sections: z.array(sectionSchema),
  visibleSections: z.array(sectionSchema),
  currentSection: sectionSchema.nullable(),
  sectionHomeHrefs: z.record(z.string(), localHrefSchema),
  sectionNavigation: z.array(navNodeSchema),
  sectionRoutes: z.array(navPageSchema),
  routeTitle: z.string().nullable(),
  sectionHeading: z.string().nullable(),
  previous: navPageSchema.nullable(),
  next: navPageSchema.nullable(),
  document: routeDocumentSchema.nullable(),
  rawDoc: z
    .object({ body: z.string(), title: z.string(), description: z.string() })
    .strict()
    .nullable(),
  runtimeDocument: parsedDocumentSchema.nullable(),
  icons: routeIconsSchema.optional(),
} as const;

export const publicDocsRouteDataV1Schema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("redirect"),
      href: localHrefSchema,
      status: z.union([
        z.literal(301),
        z.literal(302),
        z.literal(303),
        z.literal(307),
        z.literal(308),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("router_not_found"),
      href: localHrefSchema,
      slug: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal("empty"), homeHref: localHrefSchema.nullable() })
    .strict(),
  z.object({ type: z.literal("page"), ...pageDataFields }).strict(),
  z.object({ type: z.literal("not_found"), ...pageDataFields }).strict(),
]);

export type PublicDocsRouteDataV1 = z.infer<typeof publicDocsRouteDataV1Schema>;

export const publicRouteDataResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      schemaVersion: z.literal(DOCS_PRERENDER_SCHEMA_VERSION),
      renderId: sha256Schema,
      data: publicDocsRouteDataV1Schema,
    })
    .strict(),
  z.object({ status: z.literal("version_mismatch") }).strict(),
  z
    .object({ status: z.literal("unavailable"), retryable: z.boolean() })
    .strict(),
]);

export type PublicRouteDataResponse = z.infer<
  typeof publicRouteDataResponseSchema
>;

export const prerenderIdentitySchema = z
  .object({
    siteId: safeIdentitySegmentSchema,
    renderId: sha256Schema,
    artifactIdentity: sha256Schema,
    rendererReleaseId: sha256Schema,
    renderContextId: sha256Schema,
    artifactPrefix: z.string().min(1),
    sourceManifestPath: z.string().min(1),
    sourceArtifactVersion: safeIdentitySegmentSchema,
    trustedRequestOrigin: publicUrlSchema,
  })
  .strict();

const htmlObjectReferenceSchema = createObjectReferenceSchema(
  "html",
  "text/html; charset=utf-8",
  DOCS_PRERENDER_LIMITS.htmlBytes,
);
const dataObjectReferenceSchema = createObjectReferenceSchema(
  "json",
  "application/json; charset=utf-8",
  DOCS_PRERENDER_LIMITS.jsonBytes,
);

const prerenderRouteEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      pathname: localHrefSchema,
      html: htmlObjectReferenceSchema,
      data: dataObjectReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("redirect"),
      pathname: localHrefSchema,
      target: localHrefSchema,
      status: z.union([
        z.literal(301),
        z.literal(302),
        z.literal(303),
        z.literal(307),
        z.literal(308),
      ]),
      data: dataObjectReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("live_only"),
      pathname: localHrefSchema,
      reason: z.enum([
        "html_too_large",
        "route_data_too_large",
        "unsupported_route",
        "resource_limit",
      ]),
    })
    .strict(),
]);

export const prerenderManifestV1Schema = z
  .object({
    schemaVersion: z.literal(DOCS_PRERENDER_SCHEMA_VERSION),
    identity: prerenderIdentitySchema,
    completedAt: z.iso.datetime({ offset: true }),
    routes: z
      .array(prerenderRouteEntrySchema)
      .max(DOCS_PRERENDER_LIMITS.manifestRoutes),
  })
  .strict()
  .superRefine((manifest, context) => {
    let previousPathname: string | undefined;
    for (const [index, route] of manifest.routes.entries()) {
      if (route.pathname === previousPathname) {
        context.addIssue({
          code: "custom",
          message: "Manifest route pathnames must be unique.",
          path: ["routes", index, "pathname"],
        });
      } else if (
        previousPathname !== undefined &&
        previousPathname.localeCompare(route.pathname) >= 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Manifest routes must be sorted by pathname.",
          path: ["routes", index, "pathname"],
        });
      }
      if (route.pathname.split("/").some(isDangerousObjectKey)) {
        context.addIssue({
          code: "custom",
          message: "Manifest route contains a prototype-sensitive segment.",
          path: ["routes", index, "pathname"],
        });
      }
      previousPathname = route.pathname;
    }
  });

export type PrerenderIdentity = z.infer<typeof prerenderIdentitySchema>;
export type PrerenderObjectReference =
  | z.infer<typeof htmlObjectReferenceSchema>
  | z.infer<typeof dataObjectReferenceSchema>;
export type PrerenderManifestV1 = z.infer<typeof prerenderManifestV1Schema>;

export function samePrerenderIdentity(
  left: PrerenderIdentity,
  right: PrerenderIdentity,
): boolean {
  return (
    left.siteId === right.siteId &&
    left.renderId === right.renderId &&
    left.artifactIdentity === right.artifactIdentity &&
    left.rendererReleaseId === right.rendererReleaseId &&
    left.renderContextId === right.renderContextId &&
    left.artifactPrefix === right.artifactPrefix &&
    left.sourceManifestPath === right.sourceManifestPath &&
    left.sourceArtifactVersion === right.sourceArtifactVersion &&
    left.trustedRequestOrigin === right.trustedRequestOrigin
  );
}

export function parsePrerenderManifestV1(value: unknown): PrerenderManifestV1 {
  const parsed = prerenderManifestV1Schema.parse(
    omitUndefinedObjectProperties(value),
  );
  assertJsonBounds(
    parsed,
    DOCS_PRERENDER_LIMITS.manifestBytes,
    "pre-render manifest",
  );
  assertSafeRelativePath(parsed.identity.artifactPrefix, "artifact prefix");
  assertSafeRelativePath(
    parsed.identity.sourceManifestPath,
    "source manifest path",
  );
  if (
    !parsed.identity.sourceManifestPath.startsWith(
      `${parsed.identity.artifactPrefix}/`,
    )
  ) {
    throw new Error("The source manifest path is outside the artifact prefix.");
  }
  const origin = new URL(parsed.identity.trustedRequestOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== parsed.identity.trustedRequestOrigin
  ) {
    throw new Error("The trusted request origin must be an HTTPS origin.");
  }
  return parsed;
}

export function parsePublicDocsRouteDataV1(
  value: unknown,
): PublicDocsRouteDataV1 {
  const parsed = publicDocsRouteDataV1Schema.parse(
    omitUndefinedObjectProperties(value),
  );
  assertJsonBounds(parsed, DOCS_PRERENDER_LIMITS.jsonBytes);
  assertSafeObjectKeys(parsed);
  assertSafeMdxUrls(parsed);
  return parsed;
}

export function parsePublicRouteDataResponse(
  value: unknown,
): PublicRouteDataResponse {
  const parsed = publicRouteDataResponseSchema.parse(
    omitUndefinedObjectProperties(value),
  );
  assertJsonBounds(parsed, DOCS_PRERENDER_LIMITS.jsonBytes);
  assertSafeObjectKeys(parsed);
  assertSafeMdxUrls(parsed);
  return parsed;
}

export interface ArtifactIdentityInput {
  schemaVersion: 1;
  siteId: string;
  artifactPrefix: string;
  sourceManifestPath: string;
}

export interface RendererReleaseIdentityInput {
  schemaVersion: 1;
  serverPackageDigest: string;
  clientAssetManifestDigest: string;
  outputSchemaVersion: number;
}

export interface RenderContextIdentityInput {
  schemaVersion: 1;
  trustedRequestOrigin: string;
  effectivePublicOutputConfiguration: JsonObject;
}

export interface RenderIdentityInput {
  schemaVersion: 1;
  siteId: string;
  artifactIdentity: string;
  rendererReleaseId: string;
  renderContextId: string;
}

export interface PrerenderIdentityInput {
  siteId: string;
  artifactPrefix: string;
  sourceManifestPath: string;
  rendererReleaseId: string;
  trustedRequestOrigin: string;
  effectivePublicOutputConfiguration?: JsonObject;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export async function createArtifactIdentity(
  input: ArtifactIdentityInput,
): Promise<string> {
  assertSafeIdentitySegment(input.siteId, "site ID");
  assertSafeRelativePath(input.artifactPrefix, "artifact prefix");
  assertSafeRelativePath(input.sourceManifestPath, "source manifest path");
  if (!input.sourceManifestPath.startsWith(`${input.artifactPrefix}/`)) {
    throw new Error("The source manifest path is outside the artifact prefix.");
  }
  return hashCanonicalJson({
    artifactPrefix: input.artifactPrefix,
    schemaVersion: input.schemaVersion,
    siteId: input.siteId,
    sourceManifestPath: input.sourceManifestPath,
  });
}

export async function createRendererReleaseId(
  input: RendererReleaseIdentityInput,
): Promise<string> {
  if (
    !input.serverPackageDigest ||
    !input.clientAssetManifestDigest ||
    !Number.isInteger(input.outputSchemaVersion)
  ) {
    throw new Error("The renderer release identity is invalid.");
  }
  return hashCanonicalJson({
    clientAssetManifestDigest: input.clientAssetManifestDigest,
    outputSchemaVersion: input.outputSchemaVersion,
    schemaVersion: input.schemaVersion,
    serverPackageDigest: input.serverPackageDigest,
  });
}

export async function createRenderContextId(
  input: RenderContextIdentityInput,
): Promise<string> {
  const origin = new URL(input.trustedRequestOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.trustedRequestOrigin
  ) {
    throw new Error("The trusted request origin must be an HTTPS origin.");
  }
  assertJsonValue(input.effectivePublicOutputConfiguration);
  return hashCanonicalJson({
    effectivePublicOutputConfiguration:
      input.effectivePublicOutputConfiguration,
    schemaVersion: input.schemaVersion,
    trustedRequestOrigin: input.trustedRequestOrigin,
  });
}

export async function createRenderId(
  input: RenderIdentityInput,
): Promise<string> {
  assertSafeIdentitySegment(input.siteId, "site ID");
  for (const [label, value] of [
    ["artifact identity", input.artifactIdentity],
    ["renderer release ID", input.rendererReleaseId],
    ["render context ID", input.renderContextId],
  ] as const) {
    if (!sha256Schema.safeParse(value).success)
      throw new Error(`The ${label} is invalid.`);
  }
  return hashCanonicalJson({
    artifactIdentity: input.artifactIdentity,
    renderContextId: input.renderContextId,
    rendererReleaseId: input.rendererReleaseId,
    schemaVersion: input.schemaVersion,
    siteId: input.siteId,
  });
}

export async function createPrerenderIdentity(
  input: PrerenderIdentityInput,
): Promise<PrerenderIdentity> {
  const artifactIdentity = await createArtifactIdentity({
    schemaVersion: DOCS_PRERENDER_SCHEMA_VERSION,
    siteId: input.siteId,
    artifactPrefix: input.artifactPrefix,
    sourceManifestPath: input.sourceManifestPath,
  });
  const renderContextId = await createRenderContextId({
    schemaVersion: DOCS_PRERENDER_SCHEMA_VERSION,
    trustedRequestOrigin: input.trustedRequestOrigin,
    effectivePublicOutputConfiguration:
      input.effectivePublicOutputConfiguration ?? {},
  });
  const renderId = await createRenderId({
    schemaVersion: DOCS_PRERENDER_SCHEMA_VERSION,
    siteId: input.siteId,
    artifactIdentity,
    rendererReleaseId: input.rendererReleaseId,
    renderContextId,
  });
  const sourceArtifactVersion = input.artifactPrefix.split("/").at(-1);
  if (!sourceArtifactVersion) {
    throw new Error("The artifact prefix has no source version segment.");
  }
  return prerenderIdentitySchema.parse({
    siteId: input.siteId,
    renderId,
    artifactIdentity,
    rendererReleaseId: input.rendererReleaseId,
    renderContextId,
    artifactPrefix: input.artifactPrefix,
    sourceManifestPath: input.sourceManifestPath,
    sourceArtifactVersion,
    trustedRequestOrigin: input.trustedRequestOrigin,
  });
}

export function createPrerenderObjectKey(
  siteId: string,
  renderId: string,
  digest: string,
  extension: "html" | "json",
): string {
  if (!sha256Schema.safeParse(digest).success) {
    throw new Error("The pre-render object identity is invalid.");
  }
  return `${createPrerenderRenderPrefix(siteId, renderId)}objects/${digest}.${extension}`;
}

export function createPrerenderManifestKey(
  siteId: string,
  renderId: string,
): string {
  return `${createPrerenderRenderPrefix(siteId, renderId)}manifest.json`;
}

/** Every object of one render lives under this prefix. Deletion uses it. */
export function createPrerenderRenderPrefix(
  siteId: string,
  renderId: string,
): string {
  assertSafeIdentitySegment(siteId, "site ID");
  if (!sha256Schema.safeParse(renderId).success)
    throw new Error("The render ID is invalid.");
  return `render/v1/sites/${siteId}/renders/${renderId}/`;
}

/** Every render of one site lives under this prefix. */
export function createPrerenderSitePrefix(siteId: string): string {
  assertSafeIdentitySegment(siteId, "site ID");
  return `render/v1/sites/${siteId}/`;
}

export function canonicalJson(value: JsonValue): string {
  assertJsonValue(value);
  return JSON.stringify(sortJsonValue(value));
}

export function normalizePublicDocsPathname(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /%(?:2f|5c)/i.test(value)
  ) {
    throw new Error("The docs pathname is invalid.");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("The docs pathname contains malformed encoding.");
  }
  if (
    decoded.length > DOCS_PRERENDER_LIMITS.decodedPathnameCharacters ||
    decoded.includes("\\") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("The docs pathname is outside the allowed bounds.");
  }

  const withoutTrailingSlash = decoded.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

async function hashCanonicalJson(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key]!)]),
  );
}

function assertJsonValue(
  value: unknown,
  depth = 0,
): asserts value is JsonValue {
  if (depth > DOCS_PRERENDER_LIMITS.jsonDepth)
    throw new Error("JSON depth exceeds the limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("JSON numbers must be finite.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) throw new Error("The value is not JSON-safe.");
  for (const [key, item] of Object.entries(value)) {
    assertSafeObjectKey(key);
    assertJsonValue(item, depth + 1);
  }
}

function omitUndefinedObjectProperties(value: unknown, depth = 0): unknown {
  if (depth > DOCS_PRERENDER_LIMITS.jsonDepth) {
    throw new Error("JSON depth exceeds the limit.");
  }
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedObjectProperties(item, depth + 1));
  }
  if (!isPlainRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => {
        assertSafeObjectKey(key);
        return [key, omitUndefinedObjectProperties(item, depth + 1)];
      }),
  );
}

function assertJsonBounds(
  value: unknown,
  byteLimit: number,
  label = "route-data payload",
): void {
  assertJsonValue(value);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > byteLimit)
    throw new Error(`The ${label} exceeds the size limit.`);
  const counts = countJson(value);
  if (counts.nodes > DOCS_PRERENDER_LIMITS.jsonNodes)
    throw new Error("The route-data payload has too many nodes.");
  if (counts.arrayItems > DOCS_PRERENDER_LIMITS.jsonArrayItems)
    throw new Error("The route-data payload has too many array items.");
  if (counts.objectKeys > DOCS_PRERENDER_LIMITS.jsonObjectKeys)
    throw new Error("The route-data payload has too many object keys.");
}

function createObjectReferenceSchema(
  extension: "html" | "json",
  contentType: string,
  byteLimit: number,
) {
  return z
    .object({
      digest: sha256Schema,
      byteLength: z.number().int().min(0).max(byteLimit),
      contentType: z.literal(contentType),
      objectName: z.string(),
    })
    .strict()
    .superRefine((reference, context) => {
      if (reference.objectName !== `objects/${reference.digest}.${extension}`) {
        context.addIssue({
          code: "custom",
          message: "Object name does not match its content digest.",
          path: ["objectName"],
        });
      }
    });
}

function countJson(value: JsonValue): {
  nodes: number;
  arrayItems: number;
  objectKeys: number;
} {
  let nodes = 1;
  let arrayItems = 0;
  let objectKeys = 0;
  if (Array.isArray(value)) {
    arrayItems += value.length;
    for (const item of value) {
      const child = countJson(item);
      nodes += child.nodes;
      arrayItems += child.arrayItems;
      objectKeys += child.objectKeys;
    }
  } else if (isPlainRecord(value)) {
    objectKeys += Object.keys(value).length;
    for (const item of Object.values(value)) {
      const child = countJson(item);
      nodes += child.nodes;
      arrayItems += child.arrayItems;
      objectKeys += child.objectKeys;
    }
  }
  return { nodes, arrayItems, objectKeys };
}

export function assertSafeObjectKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeObjectKeys(item);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    assertSafeObjectKey(key);
    assertSafeObjectKeys(item);
  }
}

function assertSafeMdxUrls(
  value: PublicDocsRouteDataV1 | PublicRouteDataResponse,
): void {
  let routeData: PublicDocsRouteDataV1;
  if ("status" in value) {
    if (value.status !== "ok") return;
    routeData = value.data;
  } else {
    routeData = value;
  }
  if (routeData.type !== "page" && routeData.type !== "not_found") return;
  const runtime = routeData.runtimeDocument;
  if (!runtime?.ok) return;
  for (const node of runtime.document.nodes) assertSafeMdxNode(node);
}

// React renders these properties as executable markup or as a navigable URL.
// The MDX parser cannot produce them today. This list keeps the stored
// contract as narrow as its producer.
const UNSAFE_MDX_PROP_NAMES = new Set([
  "dangerouslysetinnerhtml",
  "srcdoc",
  "innerhtml",
  "outerhtml",
]);
const URL_MDX_PROP_NAMES =
  /^(href|src|url|to|link|action|formaction|poster|background|cite|ping|longdesc)$/i;
const EVENT_MDX_PROP_NAMES =
  /^(on[A-Z]|on(abort|animation|blur|change|click|copy|cut|drag|drop|error|focus|input|key|load|mouse|paste|pointer|reset|scroll|select|submit|touch|transition|wheel))/;

function assertSafeMdxNode(node: PublicRuntimeMdxNode, depth = 1): void {
  if (depth > DOCS_PRERENDER_LIMITS.jsonDepth)
    throw new Error("MDX node depth exceeds the limit.");
  if (node.type === "text") return;
  for (const [name, value] of Object.entries(node.props ?? {})) {
    assertSafeMdxPropName(name);
    if (
      typeof value === "string" &&
      URL_MDX_PROP_NAMES.test(name) &&
      !isSafePublicLink(value)
    ) {
      throw new Error(`Unsafe URL in MDX property ${name}.`);
    }
    if (isPlainRecord(value)) {
      for (const key of Object.keys(value)) assertSafeMdxPropName(key);
    }
  }
  for (const child of node.children ?? []) assertSafeMdxNode(child, depth + 1);
}

function assertSafeMdxPropName(name: string): void {
  assertSafeObjectKey(name);
  const normalized = name.toLowerCase();
  if (
    UNSAFE_MDX_PROP_NAMES.has(normalized) ||
    EVENT_MDX_PROP_NAMES.test(name) ||
    normalized.startsWith("xlink:") ||
    normalized.startsWith("xmlns")
  ) {
    throw new Error(`Unsafe MDX property ${name}.`);
  }
}

function isSafePublicLink(value: string): boolean {
  return (
    /^(https?:|mailto:|#)/i.test(value) ||
    (value.startsWith("/") && !value.startsWith("//"))
  );
}

function assertSafeIdentitySegment(value: string, label: string): void {
  if (!safeIdentitySegmentSchema.safeParse(value).success)
    throw new Error(`The ${label} is invalid.`);
}

function assertSafeRelativePath(value: string, label: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
}

function assertSafeObjectKey(key: string): void {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error("The payload contains an unsafe object key.");
  }
}

function isDangerousObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

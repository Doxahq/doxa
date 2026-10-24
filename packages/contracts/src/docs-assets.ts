import { z } from "zod";

/**
 * Images that agents upload to a branch with the `upload_asset` MCP tool.
 *
 * An asset is one file of a version at `assets/{name}`. A published version
 * serves it at `/assets/{name}` on the docs host, so a page links to it with
 * that path. The name is a lowercase slug with the extension of the detected
 * type, never the type that the uploaded file name claims.
 */
export const DOCS_ASSET_LIMITS = {
  /** Decoded bytes of one file. Base64 makes the tool call about 6.7 MB. */
  maxBytes: 5 * 1024 * 1024,
  /** Assets that one branch can add or replace. */
  maxFilesPerBranch: 50,
  /** Characters of the name before its extension. */
  maxBaseNameLength: 60,
} as const;

/** Each accepted type and the one extension a stored name uses for it. */
export const DOCS_ASSET_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
} as const;

export type DocsAssetContentType = keyof typeof DOCS_ASSET_EXTENSIONS;
export type DocsAssetExtension =
  (typeof DOCS_ASSET_EXTENSIONS)[DocsAssetContentType];

export const docsAssetContentTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

const CONTENT_TYPES_BY_EXTENSION: ReadonlyMap<string, DocsAssetContentType> =
  new Map(
    docsAssetContentTypeSchema.options.map((type) => [
      DOCS_ASSET_EXTENSIONS[type],
      type,
    ]),
  );

const DOCS_ASSET_FILE_NAME_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,${DOCS_ASSET_LIMITS.maxBaseNameLength - 2}}[a-z0-9])?\\.(?:png|jpg|webp|gif|svg)$`,
);

/** A stored asset name, for example `rate-limits-diagram.png`. */
export const docsAssetFileNameSchema = z
  .string()
  .regex(DOCS_ASSET_FILE_NAME_PATTERN, "invalid_asset_name")
  .refine((name) => !name.includes("--"), "invalid_asset_name");

const ASSET_DIRECTORY = "assets/";

/** The artifact path of an asset inside a version and a branch. */
export function docsAssetArtifactPath(name: string): string {
  return `${ASSET_DIRECTORY}${docsAssetFileNameSchema.parse(name)}`;
}

/** The path that a page uses for the asset, on every docs host. */
export function docsAssetUrlPath(name: string): string {
  return `/${docsAssetArtifactPath(name)}`;
}

/**
 * The query parameter that pins an asset URL to the content hash of the
 * file. The docs renderer adds it, and a response to a URL whose hash matches
 * the served file can be cached for a year.
 */
export const DOCS_ASSET_VERSION_PARAM = "v";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** `/assets/{name}?v={sha256}`: the immutable URL of one asset file. */
export function docsAssetVersionedUrlPath(
  name: string,
  sha256: string,
): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("An asset version must be a SHA-256 hex digest.");
  }
  return `${docsAssetUrlPath(name)}?${DOCS_ASSET_VERSION_PARAM}=${sha256}`;
}

/** The content hash that a request URL pins, or null when it pins none. */
export function docsAssetVersionFromUrl(url: URL): string | null {
  const value = url.searchParams.get(DOCS_ASSET_VERSION_PARAM);
  return value && SHA256_PATTERN.test(value) ? value : null;
}

/**
 * The asset names that a page source links to as `/assets/{name}`. The docs
 * runtime looks up only these names in the version tree.
 */
export function docsAssetNamesInSource(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /\/assets\/([a-z0-9-]+\.(?:png|jpg|webp|gif|svg))(?![a-z0-9])/g,
  )) {
    const name = match[1] ?? "";
    if (docsAssetFileNameSchema.safeParse(name).success) names.add(name);
  }
  return [...names];
}

/** The asset name of an artifact path, or null for any other path. */
export function docsAssetNameFromArtifactPath(path: string): string | null {
  if (!path.startsWith(ASSET_DIRECTORY)) return null;
  const name = path.slice(ASSET_DIRECTORY.length);
  return docsAssetFileNameSchema.safeParse(name).success ? name : null;
}

/** The asset name of a request path such as `/assets/x.png`, or null. */
export function docsAssetNameFromUrlPath(pathname: string): string | null {
  return pathname.startsWith("/")
    ? docsAssetNameFromArtifactPath(pathname.slice(1))
    : null;
}

/** The type that a valid asset name stands for. */
export function docsAssetContentTypeForName(
  name: string,
): DocsAssetContentType | null {
  if (!docsAssetFileNameSchema.safeParse(name).success) return null;
  const extension = name.slice(name.lastIndexOf(".") + 1);
  return CONTENT_TYPES_BY_EXTENSION.get(extension) ?? null;
}

/** The result of `upload_asset`. */
export const docsAssetUploadResultSchema = z
  .object({
    path: z
      .string()
      .describe("The path to use in MDX, for example /assets/diagram.png."),
    markdown: z
      .string()
      .describe("An MDX image line with this path and the alt text."),
    contentType: docsAssetContentTypeSchema,
    size: z.number().int().nonnegative(),
    sanitized: z
      .boolean()
      .describe(
        "True when the SVG cleaning removed content: scripts, event attributes, or external references.",
      ),
    reused: z
      .boolean()
      .describe(
        "True when the branch already had the same file at this path; nothing was written.",
      ),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export type DocsAssetUploadResult = z.infer<typeof docsAssetUploadResultSchema>;

/**
 * The result of `POST /projects/:id/branches/:ref/assets`, the dashboard
 * upload. It is the `upload_asset` result without the markdown line, which
 * the editor builds itself.
 */
export const docsBranchAssetUploadResponseSchema =
  docsAssetUploadResultSchema.omit({ markdown: true });

export type DocsBranchAssetUploadResponse = z.infer<
  typeof docsBranchAssetUploadResponseSchema
>;

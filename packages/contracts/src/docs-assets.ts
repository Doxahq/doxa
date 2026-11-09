import { z } from "zod";

/**
 * Images that agents upload to a branch with the `upload_asset` MCP tool.
 *
 * An asset is one file of a version at `assets/{name}`. A published version
 * serves it at `/assets/{name}` on the docs host, so a page links to it with
 * that path. The name is a lowercase slug with the extension of the stored
 * type, never the type that the uploaded file name claims. The stored type
 * can differ from the uploaded one: a PNG or JPEG image can become WebP.
 */
export const DOCS_ASSET_LIMITS = {
  /** Decoded bytes of one file, on every upload path. */
  maxBytes: 2 * 1024 * 1024,
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

/**
 * An upload URL from `create_asset_upload`. The agent sends the file to the
 * URL with one HTTP PUT, then calls `finish_asset_upload`. The file bytes
 * never pass through the model, so the size of the file does not matter to
 * the tool call.
 */
export const AGENT_ASSET_UPLOAD_LIMITS = {
  /** How long the upload URL accepts the file and the upload can finish. */
  ttlSeconds: 15 * 60,
  /**
   * Upload URLs that one connection (member and OAuth client) can hold open
   * at once. An open URL has not finished and has not expired.
   */
  maxOpenPerConnection: 5,
  /**
   * Open upload URLs of one member across all their OAuth clients. With the
   * image limit, this caps the staged bytes of one member at 20 MB.
   */
  maxOpenPerMember: 10,
  /** Refused PUTs (not an image, too large, too slow) before the URL closes. */
  maxFailedAttempts: 5,
  /** How long the upload URL waits for the whole request body. */
  bodyTimeoutSeconds: 60,
  /** Small files can go inline with `upload_asset`; larger ones use a URL. */
  inlineBytesHint: 100 * 1024,
} as const;

/** The scheme of the Authorization header that carries the upload secret. */
export const AGENT_ASSET_UPLOAD_AUTH_SCHEME = "Bearer";

/** The path of the upload URL on the MCP host, before the upload ID. */
export const AGENT_ASSET_UPLOAD_PATH = "/uploads/";

export const agentAssetUploadIdSchema = z.uuid();

/** The result of `create_asset_upload`. */
export const agentAssetUploadTicketSchema = z
  .object({
    uploadId: z
      .uuid()
      .describe("Pass it to finish_asset_upload after the PUT."),
    uploadUrl: z
      .string()
      .describe("Send the raw file bytes here with one HTTP PUT, with the headers below."),
    method: z.literal("PUT"),
    headers: z
      .object({ Authorization: z.string() })
      .strict()
      .describe(
        "Send these headers with the PUT. The Authorization value is a secret for this one upload: never put it in a page, a file, or a message.",
      ),
    maxBytes: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    curl: z
      .string()
      .describe(
        "A ready command: replace FILE with the local path of the image.",
      ),
  })
  .strict();

export type AgentAssetUploadTicket = z.infer<
  typeof agentAssetUploadTicketSchema
>;

/** The JSON body that the upload URL returns after a PUT. */
export const agentAssetUploadReceiptSchema = z
  .object({
    uploadId: z.uuid(),
    size: z.number().int().nonnegative(),
    next: z.string(),
  })
  .strict();

/** The result of `upload_asset`. */
export const docsAssetUploadResultSchema = z
  .object({
    path: z
      .string()
      .describe(
        "The path to use in MDX, for example /assets/diagram.png. Its extension is the stored type, which can differ from the file you sent.",
      ),
    markdown: z
      .string()
      .describe("An MDX image line with this path and the alt text."),
    contentType: docsAssetContentTypeSchema.describe("The type of the stored file."),
    size: z.number().int().nonnegative().describe("The bytes of the stored file."),
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

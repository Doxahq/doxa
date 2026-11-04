import type { CacheEntrypoint } from "./worker-exports";

/**
 * Old client assets (M27). A page that a visitor loaded before a renderer
 * deploy still asks for the hashed client files of the old build. The static
 * `ASSETS` binding has only the new build's files, so it does not answer and
 * the request reaches the Worker. The deploy uploads every build's client files
 * to R2, and `DocsClientAssetCache` serves them from there.
 */

export type ClientAssetFallbackMode = "off" | "on";

export interface ClientAssetFallbackEnv {
  DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE?: string;
}

/**
 * Increase this value when the cached response changes shape. With
 * `cross_version_cache`, older and newer deploys share one key otherwise.
 */
export const CLIENT_ASSET_CACHE_FORMAT = 1;

const CLIENT_ASSET_CACHE_ORIGIN = "https://client-assets.internal";

/** Set only by the dispatcher, from a file name that passed the pattern. */
export interface ClientAssetCacheProps {
  file: string;
  format: number;
}

// A Vite output name: `{name}-{8-character hash}.js|css`. The name may contain
// dots (`cytoscape.esm-D3_iZ_3b.js`), never `..`, `/`, `%` or `\`. Customer
// images under `/assets/` are lowercase image names and never match.
const CLIENT_ASSET_FILE_PATTERN =
  /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._-]{0,119}-[A-Za-z0-9_-]{8}\.(js|css)$/;
const CLIENT_ASSET_PATH_PREFIX = "/assets/";

const CONTENT_TYPES = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
} as const;

export function parseClientAssetFallbackMode(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): ClientAssetFallbackMode {
  if (value === "on") return "on";
  if (value !== undefined && value !== "off") {
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE ${JSON.stringify(value)}; old client assets are not served.`,
    );
  }
  return "off";
}

export function isClientAssetFileName(file: string): boolean {
  return CLIENT_ASSET_FILE_PATTERN.test(file);
}

/** The client asset file of a `GET` or `HEAD` request, or null. */
export function matchClientAssetRequest(request: Request): string | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(CLIENT_ASSET_PATH_PREFIX)) return null;
  const file = pathname.slice(CLIENT_ASSET_PATH_PREFIX.length);
  return isClientAssetFileName(file) ? file : null;
}

/** The content type of a valid client asset file name. */
export function clientAssetContentType(file: string): string | null {
  const match = CLIENT_ASSET_FILE_PATTERN.exec(file);
  const extension = match?.[1];
  if (extension === "js" || extension === "css") return CONTENT_TYPES[extension];
  return null;
}

export function createClientAssetCacheUrl(file: string): string {
  return `${CLIENT_ASSET_CACHE_ORIGIN}/v${CLIENT_ASSET_CACHE_FORMAT}/${file}`;
}

interface ClientAssetFallbackDependencies {
  mode: ClientAssetFallbackMode;
  cache(): CacheEntrypoint<ClientAssetCacheProps>;
}

/**
 * Serves an old client asset, or returns null for every other request and
 * when the fallback is off. The cache always sees the same `GET`; a visitor
 * `HEAD` gets the stored response without a body.
 */
export async function handleClientAssetFallback(
  request: Request,
  dependencies: ClientAssetFallbackDependencies,
): Promise<Response | null> {
  if (dependencies.mode !== "on") return null;
  const file = matchClientAssetRequest(request);
  if (!file) return null;
  const cached = await dependencies
    .cache()({ props: { file, format: CLIENT_ASSET_CACHE_FORMAT } })
    .fetch(new Request(createClientAssetCacheUrl(file)));
  const cacheStatus = cached.headers.get("cf-cache-status") ?? "UNAVAILABLE";
  console.info(
    JSON.stringify({
      event: "docs_client_asset_fallback",
      file,
      status: cached.status,
      cacheStatus,
    }),
  );
  const isHead = request.method === "HEAD";
  if (isHead) await cached.body?.cancel();
  return new Response(isHead ? null : cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

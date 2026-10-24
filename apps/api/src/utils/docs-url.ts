import { normalizeDocsHostname } from "./hostname";

export interface DocsUrlEnv {
  DOCS_BASE_DOMAIN?: string;
  DOCS_RENDERER_BASE_URL?: string;
  DOCS_RUNTIME_URL?: string;
}

export interface GeneratedDocsSubdomain {
  hostname: string;
  projectSlug: string;
}

export interface GenerationPreviewSubdomain {
  hostname: string;
  projectSlug: string;
  versionIdPrefix: string;
}

export const GENERATION_PREVIEW_SEPARATOR = "--";
export const GENERATION_PREVIEW_ID_LENGTH = 12;

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_ID_PREFIX_PATTERN = /^[a-f0-9]{12}$/;

export function createDocsUrl(
  projectSlug: string,
  env: DocsUrlEnv,
): string | null {
  const generatedHostname = createGeneratedDocsHostname(
    projectSlug,
    env.DOCS_BASE_DOMAIN,
  );
  if (generatedHostname) {
    return createDocsHostnameUrl(generatedHostname, env);
  }

  const runtimeBaseUrl = env.DOCS_RUNTIME_URL?.trim().replace(/\/+$/, "");
  return runtimeBaseUrl ? `${runtimeBaseUrl}/${projectSlug}` : null;
}

export function createDocsHostnameUrl(
  hostname: string,
  env: Pick<DocsUrlEnv, "DOCS_RENDERER_BASE_URL">,
): string {
  return (
    createRendererUrl(hostname, env.DOCS_RENDERER_BASE_URL) ??
    `https://${hostname}`
  );
}

function createRendererUrl(
  hostname: string,
  baseUrl: string | undefined,
): string | null {
  if (!baseUrl?.trim()) return null;

  try {
    const url = new URL(baseUrl);
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    const isOriginOnly = url.pathname === "/" && !url.search && !url.hash;
    if (!isHttp || !isOriginOnly || url.username || url.password) return null;

    url.hostname = hostname;
    return url.origin;
  } catch {
    return null;
  }
}

export function createGeneratedDocsHostname(
  projectSlug: string,
  docsBaseDomain: string | undefined,
): string | null {
  const baseDomain = normalizeOptionalDocsHostname(docsBaseDomain);
  const normalizedProjectSlug = projectSlug.trim().toLowerCase();
  if (!baseDomain || !PROJECT_SLUG_PATTERN.test(normalizedProjectSlug)) {
    return null;
  }

  return normalizeDocsHostname(`${normalizedProjectSlug}.${baseDomain}`);
}

export function createGenerationPreviewHostname(
  input: { projectSlug: string; docsVersionId: string },
  docsBaseDomain: string | undefined,
): string | null {
  const baseDomain = normalizeOptionalDocsHostname(docsBaseDomain);
  const projectSlug = input.projectSlug.trim().toLowerCase();
  // UUID separators are not part of the 12 hexadecimal URL identifier.
  const versionIdPrefix = input.docsVersionId
    .trim()
    .toLowerCase()
    .replaceAll("-", "")
    .slice(0, GENERATION_PREVIEW_ID_LENGTH);
  if (
    !baseDomain ||
    !PROJECT_SLUG_PATTERN.test(projectSlug) ||
    !VERSION_ID_PREFIX_PATTERN.test(versionIdPrefix)
  ) {
    return null;
  }

  return normalizeDocsHostname(
    `${projectSlug}${GENERATION_PREVIEW_SEPARATOR}${versionIdPrefix}.${baseDomain}`,
  );
}

/** The URL that serves one docs version, whatever its status, or null when the host cannot be built. */
export function createGenerationPreviewUrl(
  input: { projectSlug: string; docsVersionId: string },
  env: Pick<DocsUrlEnv, "DOCS_BASE_DOMAIN" | "DOCS_RENDERER_BASE_URL">,
): string | null {
  const hostname = createGenerationPreviewHostname(input, env.DOCS_BASE_DOMAIN);
  return hostname ? createDocsHostnameUrl(hostname, env) : null;
}

export function parseGenerationPreviewSubdomain(
  hostname: string,
  docsBaseDomain: string | undefined,
): GenerationPreviewSubdomain | null {
  const canonicalHostname = hostname.trim().replace(/\.+$/, "");
  if (canonicalHostname !== canonicalHostname.toLowerCase()) return null;

  const normalizedHostname = normalizeDocsHostname(hostname);
  const baseDomain = normalizeOptionalDocsHostname(docsBaseDomain);
  if (!normalizedHostname || !baseDomain) return null;

  const suffix = `.${baseDomain}`;
  if (!normalizedHostname.endsWith(suffix)) return null;

  const label = normalizedHostname.slice(0, -suffix.length);
  if (label.includes(".")) return null;

  const parts = label.split(GENERATION_PREVIEW_SEPARATOR);
  if (parts.length !== 2) return null;

  const [projectSlug, versionIdPrefix] = parts;
  if (
    !projectSlug ||
    !versionIdPrefix ||
    !PROJECT_SLUG_PATTERN.test(projectSlug) ||
    !VERSION_ID_PREFIX_PATTERN.test(versionIdPrefix)
  ) {
    return null;
  }

  return { hostname: normalizedHostname, projectSlug, versionIdPrefix };
}

export function parseGeneratedDocsSubdomain(
  hostname: string,
  docsBaseDomain: string | undefined,
): GeneratedDocsSubdomain | null {
  const normalizedHostname = normalizeDocsHostname(hostname);
  const baseDomain = normalizeOptionalDocsHostname(docsBaseDomain);
  if (!normalizedHostname || !baseDomain || normalizedHostname === baseDomain)
    return null;

  const suffix = `.${baseDomain}`;
  if (!normalizedHostname.endsWith(suffix)) return null;

  const projectSlug = normalizedHostname.slice(0, -suffix.length);
  if (
    projectSlug.includes(".") ||
    normalizeDocsHostname(projectSlug) !== projectSlug
  )
    return null;

  return {
    hostname: normalizedHostname,
    projectSlug,
  };
}

function normalizeOptionalDocsHostname(
  hostname: string | undefined,
): string | null {
  return hostname ? normalizeDocsHostname(hostname) : null;
}

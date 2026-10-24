const GENERATION_PREVIEW_SEPARATOR = "--";
const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_ID_PREFIX_PATTERN = /^[a-f0-9]{12}$/;

// This mirrors parseGenerationPreviewSubdomain in
// apps/api/src/utils/docs-url.ts. It is duplicated on purpose: the renderer
// must not depend on platform packages. It reads a hostname shape and nothing
// else. Change both files together, and keep the tests in both repositories
// pinned to the same examples.
//
// The two functions must never disagree in one direction: a hostname that the
// API resolves must return true here, or the gate lets a private preview
// through. So this function strips a scheme, a path, and a port exactly as the
// API does. It can be more permissive than the API, because that only gates a
// request the API then rejects. It must never be less permissive.
export function isGenerationPreviewHostname(
  hostname: string,
  docsBaseDomain: string | undefined
): boolean {
  const canonicalHostname = normalizeHostname(hostname);
  const baseDomain = normalizeHostname(docsBaseDomain);
  if (
    !canonicalHostname ||
    !baseDomain ||
    canonicalHostname !== canonicalHostname.toLowerCase()
  ) {
    return false;
  }

  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!canonicalHostname.endsWith(suffix)) return false;

  const label = canonicalHostname.slice(0, -suffix.length);
  if (label.includes(".")) return false;

  const parts = label.split(GENERATION_PREVIEW_SEPARATOR);
  if (parts.length !== 2) return false;

  const [projectSlug, versionIdPrefix] = parts;
  return Boolean(
    projectSlug &&
    versionIdPrefix &&
    PROJECT_SLUG_PATTERN.test(projectSlug) &&
    VERSION_ID_PREFIX_PATTERN.test(versionIdPrefix)
  );
}

function normalizeHostname(hostname: string | undefined): string | null {
  const withoutOrigin = extractHostname(hostname?.trim() ?? "");
  const normalized = withoutOrigin.replace(/\.+$/, "");
  return normalized || null;
}

/** Mirrors extractHostname in apps/api/src/utils/hostname.ts. */
function extractHostname(input: string): string {
  if (input.includes("://")) {
    try {
      return new URL(input).hostname;
    } catch {
      return "";
    }
  }

  const withoutPath = input.split("/", 1)[0] ?? "";
  return stripPort(withoutPath);
}

function stripPort(hostname: string): string {
  const colonCount = hostname.split(":").length - 1;
  if (colonCount !== 1) return hostname;

  const [host, port] = hostname.split(":");
  return host && /^\d+$/.test(port ?? "") ? host : hostname;
}

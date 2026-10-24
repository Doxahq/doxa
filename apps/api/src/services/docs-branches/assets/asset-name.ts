import {
  DOCS_ASSET_LIMITS,
  docsAssetFileNameSchema,
  type DocsAssetExtension,
} from "@doxahq/contracts/docs-assets";

const FALLBACK_BASE_NAME = "image";

/**
 * A safe slug from the name that the agent sent: no folder, no extension,
 * lowercase ASCII letters, digits, and single hyphens. "Rate Limits
 * (v2).PNG" becomes "rate-limits-v2".
 */
export function assetBaseName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const slug = stem
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DOCS_ASSET_LIMITS.maxBaseNameLength)
    .replace(/-+$/, "");
  return slug || FALLBACK_BASE_NAME;
}

/**
 * The names to try, in order: the slug, then the slug with "-2", "-3", and
 * so on. The suffix replaces the end of a long slug, so every name is valid.
 */
export function* assetNameCandidates(
  baseName: string,
  extension: DocsAssetExtension,
): Generator<string> {
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const stem = baseName
      .slice(0, DOCS_ASSET_LIMITS.maxBaseNameLength - suffix.length)
      .replace(/-+$/, "");
    yield docsAssetFileNameSchema.parse(`${stem}${suffix}.${extension}`);
  }
}

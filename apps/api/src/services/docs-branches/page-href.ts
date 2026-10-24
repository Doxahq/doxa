import { normalizeHref } from "@doxahq/docs-engine";

/**
 * The page href of a branch source path, the inverse of `sourcePathForHref`:
 * `source/index.mdx` is "/", `source/guides/setup/index.mdx` is "/guides/setup".
 */
export function hrefForSourcePath(path: string): string {
  return normalizeHref(path.replace(/^source\//, "").replace(/index\.mdx$/, ""));
}

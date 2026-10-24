/**
 * Per-page raw markdown endpoint.
 *
 * Maps a `.md`-suffixed docs URL to the source MDX file (frontmatter
 * included), served as `text/markdown`. Invoked from `src/server.ts`,
 * which runs as the Cloudflare worker entry in both `vite dev` and
 * production builds.
 */

import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import { createConfiguredRuntimeSource } from "@/src/runtime/runtime-source-selection";

import { contentStore } from "@/src/lib/content/store";

const MD_SUFFIX = ".md";

/**
 * If `pathname` ends with `.md`, resolve it to a raw-markdown `Response`.
 * Returns `null` for any non-`.md` path, when the feature is disabled via
 * the resolved rawMarkdown feature, or for the empty-slug case — callers
 * fall through to their normal request handling.
 */
export async function tryRawMarkdownResponse(
  pathname: string,
  runtimeSource?: Pick<DoxaDocsRuntimeSource, "getRawPage" | "getFeatureConfig">
): Promise<Response | null> {
  if (!pathname.endsWith(MD_SUFFIX)) return null;

  const slug = pathname.slice(1, -MD_SUFFIX.length);
  if (!slug) return null;
  const source = runtimeSource ?? (await createConfiguredRuntimeSource());
  if (!(await source.getFeatureConfig()).rawMarkdown) return null;

  const raw = runtimeSource
    ? ((await runtimeSource.getRawPage(slug))?.body ?? null)
    : await contentStore.readRaw(slug);
  if (!raw) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

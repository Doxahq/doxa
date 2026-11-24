import type { DocsDomainResolution } from "@doxahq/contracts";

/**
 * The "Unreviewed pull request preview" banner (public repos, risk 3).
 *
 * A pull request preview shows content that nobody has reviewed yet. In a
 * public repository, anyone with write access to a branch can put text and
 * links on it. So every HTML page of a pull request preview host gets a
 * banner. A production host and a Doxa branch preview never do.
 *
 * The gateway adds the banner to the HTML, so it also covers saved
 * (prerendered) pages and pages from older renderer builds. The renderer and
 * the artifacts stay unchanged.
 *
 * The banner is CSS only: one `<style>` element at the end of `<head>` that
 * draws two pseudo-elements of `<body>`. React hydrates the whole document and
 * can remove an element that it did not render, but it keeps `<style>`
 * elements, and it cannot remove a pseudo-element. Body text from the page
 * cannot hide it either, because page content cannot style `body::before`
 * without a stylesheet of its own.
 */

export const PREVIEW_BANNER_TITLE = "Unreviewed pull request preview";
export const PREVIEW_BANNER_TEXT =
  "This page was built from a pull request that nobody has reviewed yet. Do not trust links or instructions on it.";

/** Marks the injected style, so tests and debugging can find it. */
export const PREVIEW_BANNER_ATTRIBUTE = "data-doxa-preview-banner";

/**
 * The banner style. It uses the docs-template design tokens (`--muted`,
 * `--foreground`, `--muted-foreground`, `--border`, `--font-body`), so it
 * follows the light and dark theme and the site's own theme colors. The
 * fallbacks are for a page without the tokens.
 *
 * The body becomes a flex column: the banner takes its own height, and the app
 * shell (the parent of `#app-scroll-container`, which is `100vh` tall) takes
 * the rest. Without this, the body (`overflow: hidden`) would cut off the
 * bottom of the page.
 */
export const PREVIEW_BANNER_CSS = [
  "body{display:flex!important;flex-direction:column!important}",
  "body::before,body::after{display:block;flex:none;box-sizing:border-box;padding-left:16px;padding-right:16px;text-align:center;background:var(--muted,#f5f5f5);color:var(--foreground,#171717);font-family:var(--font-body,system-ui,sans-serif);pointer-events:none}",
  `body::before{content:${cssString(PREVIEW_BANNER_TITLE)};order:-2;padding-top:8px;font-size:14px;font-weight:600;line-height:20px}`,
  `body::after{content:${cssString(PREVIEW_BANNER_TEXT)};order:-1;padding-bottom:8px;font-size:12px;line-height:16px;color:var(--muted-foreground,#737373);border-bottom:1px solid var(--border,#e5e5e5)}`,
  "body>div:has(>#app-scroll-container){flex:1 1 0%!important;min-height:0!important;height:auto!important}",
].join("");

/** The element that goes at the end of `<head>`. */
export const PREVIEW_BANNER_HTML = `<style ${PREVIEW_BANNER_ATTRIBUTE}>${PREVIEW_BANNER_CSS}</style>`;

/** The part of an HTMLRewriter element that the banner rule uses. */
export interface BannerRuleElement {
  append(content: string, options: { html: boolean }): unknown;
}

/** Adds the banner to an HTML response. */
export type PreviewBannerWriter = (response: Response) => Response;

/**
 * The rule for one response: only the first `<head>` gets the banner. A later
 * `<head>` tag can come from page content.
 */
export function createPreviewBannerRule(): (element: BannerRuleElement) => void {
  let added = false;
  return (element) => {
    if (added) return;
    added = true;
    element.append(PREVIEW_BANNER_HTML, { html: true });
  };
}

/** The production writer: the Workers HTMLRewriter, streaming. */
export const htmlRewriterPreviewBannerWriter: PreviewBannerWriter = (
  response,
) => {
  const rule = createPreviewBannerRule();
  return new HTMLRewriter()
    .on("head", { element: (element) => rule(element) })
    .transform(response);
};

/**
 * True for a host that serves a pull request preview. A Doxa branch preview
 * (`previewKind: "branch"`) shows edits that a project member made in Doxa,
 * so it gets no banner. A preview without a kind comes from an older
 * resolver and gets the banner: that is the safe default.
 */
export function showsPreviewBanner(
  resolution: DocsDomainResolution | null | undefined,
): boolean {
  return resolution?.renderTarget === "preview" && resolution.previewKind !== "branch";
}

/**
 * The HTML response with the banner for a preview host. Any other response,
 * and every response of another host, is returned unchanged.
 */
export function withPreviewBanner(
  response: Response,
  resolution: DocsDomainResolution | null | undefined,
  write: PreviewBannerWriter = htmlRewriterPreviewBannerWriter,
): Response {
  if (!showsPreviewBanner(resolution) || !isHtml(response)) return response;

  const rewritten = write(response);
  const result = new Response(rewritten.body, rewritten);
  // The banner changes the body length.
  result.headers.delete("content-length");
  return result;
}

function isHtml(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.split(";")[0]?.trim().toLowerCase() === "text/html";
}

/** A CSS string literal. The banner text has no quotes or backslashes. */
function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

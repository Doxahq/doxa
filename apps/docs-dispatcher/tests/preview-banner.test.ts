import { describe, expect, test, vi } from "vitest";

import {
  createPreviewBannerRule,
  PREVIEW_BANNER_ATTRIBUTE,
  PREVIEW_BANNER_CSS,
  PREVIEW_BANNER_HTML,
  PREVIEW_BANNER_TEXT,
  PREVIEW_BANNER_TITLE,
  withPreviewBanner,
  type PreviewBannerWriter,
} from "../src/preview-banner";

/**
 * A stand-in for HTMLRewriter, which only the Workers runtime has. It uses the
 * production rule on each `<head>` start tag.
 */
const fakeBannerWriter: PreviewBannerWriter = (response) => {
  const rule = createPreviewBannerRule();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const html = await response.text();
      const output = html.replace(/<head(\s[^>]*)?>([\s\S]*?)<\/head>/g, (tag, attributes = "", inner) => {
        let appended = "";
        rule({
          append: (content) => {
            appended += content;
          },
        });
        return `<head${attributes}>${inner}${appended}</head>`;
      });
      controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  return new Response(body, response);
};

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
  hostname: "demo-pr-12.doxa.page",
  domainKind: "doxa_subdomain" as const,
};

const PAGE = '<!DOCTYPE html><html lang="en"><head><title>Docs</title></head><body><div>Page</div></body></html>';

function htmlResponse(html = PAGE): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(html.length),
    },
  });
}

describe("pull request preview banner", () => {
  test("a preview target without a kind (an older resolver) gets the banner", async () => {
    const result = withPreviewBanner(
      htmlResponse(),
      { ...resolution, renderTarget: "preview" },
      fakeBannerWriter,
    );
    const html = await result.text();

    expect(html).toContain(`<style ${PREVIEW_BANNER_ATTRIBUTE}>`);
    expect(html).toContain(PREVIEW_BANNER_TITLE);
    expect(html).toContain(PREVIEW_BANNER_TEXT);
    // The style goes at the end of the head, after the page's own styles.
    expect(html).toContain(`<title>Docs</title>${PREVIEW_BANNER_HTML}</head>`);
    expect(result.headers.has("content-length")).toBe(false);
    expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test.each(["production", "generation_snapshot", undefined] as const)(
    "a %s target does not get the banner",
    async (renderTarget) => {
      const writer = vi.fn(fakeBannerWriter);
      const response = htmlResponse();
      const result = withPreviewBanner(response, { ...resolution, renderTarget }, writer);

      expect(result).toBe(response);
      expect(writer).not.toHaveBeenCalled();
      expect(await result.text()).not.toContain(PREVIEW_BANNER_TITLE);
    },
  );

  test("a pull request preview gets the banner", async () => {
    const result = withPreviewBanner(
      htmlResponse(),
      { ...resolution, renderTarget: "preview", previewKind: "source_change" },
      fakeBannerWriter,
    );

    expect(await result.text()).toContain(PREVIEW_BANNER_TITLE);
  });

  test("a Doxa branch preview does not get the banner", async () => {
    const writer = vi.fn(fakeBannerWriter);
    const response = htmlResponse();
    const result = withPreviewBanner(response, { ...resolution, renderTarget: "preview", previewKind: "branch" }, writer);

    expect(result).toBe(response);
    expect(writer).not.toHaveBeenCalled();
  });

  test("an unresolved host does not get the banner", () => {
    const writer = vi.fn(fakeBannerWriter);
    const response = htmlResponse();

    expect(withPreviewBanner(response, null, writer)).toBe(response);
    expect(withPreviewBanner(response, undefined, writer)).toBe(response);
    expect(writer).not.toHaveBeenCalled();
  });

  test("a preview response that is not HTML stays unchanged", () => {
    const writer = vi.fn(fakeBannerWriter);
    const response = new Response("{}", { headers: { "content-type": "application/json" } });

    expect(withPreviewBanner(response, { ...resolution, renderTarget: "preview" }, writer)).toBe(response);
    expect(writer).not.toHaveBeenCalled();
  });

  test("only the first head gets the banner", async () => {
    const html = "<html><head></head><body><head></head></body></html>";
    const result = withPreviewBanner(
      htmlResponse(html),
      { ...resolution, renderTarget: "preview" },
      fakeBannerWriter,
    );

    expect((await result.text()).split(PREVIEW_BANNER_ATTRIBUTE)).toHaveLength(2);
  });

  test("the banner uses the docs-template design tokens", () => {
    for (const token of ["--muted", "--foreground", "--muted-foreground", "--border", "--font-body"]) {
      expect(PREVIEW_BANNER_CSS).toContain(`var(${token},`);
    }
    // The app shell gives room to the banner, so the body does not cut off the page.
    expect(PREVIEW_BANNER_CSS).toContain("body>div:has(>#app-scroll-container)");
  });
});

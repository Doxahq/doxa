import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

import worker from "../src/index";
import { PREVIEW_BANNER_ATTRIBUTE, PREVIEW_BANNER_TITLE } from "../src/preview-banner";

/**
 * A stand-in for the Workers HTMLRewriter: it runs the `head` handler once per
 * `<head>` start tag and appends its content before `</head>`.
 */
class FakeHtmlRewriter {
  private readonly handlers = new Map<string, (element: unknown) => void>();

  on(selector: string, handler: { element: (element: unknown) => void }) {
    this.handlers.set(selector, handler.element);
    return this;
  }

  transform(response: Response): Response {
    const head = this.handlers.get("head");
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const html = await response.text();
        const output = html.replace(/<head>([\s\S]*?)<\/head>/g, (_tag, inner) => {
          let appended = "";
          head?.({ append: (content: string) => (appended += content) });
          return `<head>${inner}${appended}</head>`;
        });
        controller.enqueue(new TextEncoder().encode(output));
        controller.close();
      },
    });
    return new Response(body, response);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGE = "<!DOCTYPE html><html><head><title>Docs</title></head><body><div>Page</div></body></html>";

async function renderPage(
  renderTarget: "production" | "preview",
  previewKind?: "source_change" | "branch" | "future_kind",
): Promise<string> {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubGlobal("HTMLRewriter", FakeHtmlRewriter);
  const resolution = {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "demo",
    publishedVersionId: "version-1",
    artifactPrefix: "artifacts/v1",
    manifestPath: "artifacts/v1/manifest.json",
    accessPolicy: "public",
    hostname: "demo.doxa.page",
    domainKind: "doxa_subdomain",
    renderTarget,
    ...(previewKind ? { previewKind } : {}),
  };
  const ctx = {
    waitUntil: () => undefined,
    exports: {
      DocsHostCache: () => ({ fetch: async () => Response.json(resolution) }),
      DocsHtmlCache: () => ({
        fetch: async () =>
          new Response(PAGE, {
            headers: { "content-type": "text/html; charset=utf-8", "cf-cache-status": "HIT" },
          }),
      }),
    },
  };
  const env = {
    DOXA_RENDERER_BUILD_ID: "build-1",
    SHARED_RENDERER: {
      fetch: async () =>
        new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  };
  const response = await worker.fetch(
    new Request("https://demo.doxa.page/guide", { headers: { accept: "text/html" } }),
    env as never,
    ctx as never,
  );
  expect(response.status).toBe(200);
  return response.text();
}

describe("docs gateway preview banner", () => {
  test("a preview page gets the banner", async () => {
    const html = await renderPage("preview");

    expect(html).toContain(PREVIEW_BANNER_ATTRIBUTE);
    expect(html).toContain(PREVIEW_BANNER_TITLE);
  });

  test("a pull request preview page gets the banner", async () => {
    expect(await renderPage("preview", "source_change")).toContain(PREVIEW_BANNER_TITLE);
  });

  test("a preview of an unknown kind gets the banner", async () => {
    expect(await renderPage("preview", "future_kind")).toContain(PREVIEW_BANNER_TITLE);
  });

  test("a Doxa branch preview page does not get the banner", async () => {
    const html = await renderPage("preview", "branch");

    expect(html).toContain("<div>Page</div>");
    expect(html).not.toContain(PREVIEW_BANNER_ATTRIBUTE);
  });

  test("a production page does not get the banner", async () => {
    const html = await renderPage("production");

    expect(html).toContain("<div>Page</div>");
    expect(html).not.toContain(PREVIEW_BANNER_ATTRIBUTE);
    expect(html).not.toContain(PREVIEW_BANNER_TITLE);
  });
});

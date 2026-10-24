import { describe, expect, test } from "vitest";

import { createPrerenderHtmlResponse } from "../src/prerender-response";

describe("pre-render HTML response", () => {
  test("serves bounded saved HTML with current response headers", async () => {
    const html = new TextEncoder().encode("<!doctype html><p>Guide</p>");
    const response = createPrerenderHtmlResponse(
      {
        status: "hit",
        html,
        routeKind: "page",
      },
      "GET",
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("<!doctype html><p>Guide</p>");
    expect(response?.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("x-doxa-representation-source")).toBe(
      "prerender",
    );
  });

  test("returns no body for HEAD without changing the cached GET representation", async () => {
    const response = createPrerenderHtmlResponse(
      {
        status: "hit",
        html: new TextEncoder().encode("saved"),
        routeKind: "page",
      },
      "HEAD",
    );

    expect(await response?.text()).toBe("");
  });

  test("serves only validated local redirects", () => {
    const response = createPrerenderHtmlResponse(
      {
        status: "hit",
        redirect: { href: "/guide", status: 308 },
        routeKind: "redirect",
      },
      "GET",
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe("/guide");
    expect(response?.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("uses live rendering for a redirect without a manifest target", () => {
    expect(
      createPrerenderHtmlResponse(
        { status: "hit", routeKind: "redirect" },
        "GET",
      ),
    ).toBeNull();
  });

  test("uses live rendering for every non-hit lookup", () => {
    expect(
      createPrerenderHtmlResponse(
        { status: "miss", reason: "manifest_missing" },
        "GET",
      ),
    ).toBeNull();
    expect(
      createPrerenderHtmlResponse(
        { status: "invalid", reason: "digest" },
        "GET",
      ),
    ).toBeNull();
  });
});

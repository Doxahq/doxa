import { describe, expect, test } from "vitest";

import {
  withDocsPreviewSearchPolicy,
  withDocsSecurityHeaders,
} from "../src/security-headers";

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
  hostname: "demo.doxa.page",
  domainKind: "doxa_subdomain" as const,
};

describe("documentation response headers", () => {
  test.each(["preview", "generation_snapshot"] as const)(
    "blocks indexing for %s responses",
    (renderTarget) => {
      const response = withDocsPreviewSearchPolicy(new Response(), {
        ...resolution,
        renderTarget,
      });

      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      // SECURITY REGRESSION GUARDRAIL (SEC-033): a preview hostname never leaves in a Referer.
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    },
  );

  test("adds the robots policy to a response with immutable headers", async () => {
    // A service binding returns headers that cannot change. Cloudflare throws
    // on `set`, like a frozen Headers object here.
    const immutable = new Response("asset", {
      status: 200,
      headers: { "content-type": "text/css" },
    });
    Object.defineProperty(immutable, "headers", {
      value: new Proxy(immutable.headers, {
        get(target, property) {
          if (property === "set" || property === "append" || property === "delete") {
            return () => {
              throw new TypeError("Can't modify immutable headers.");
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });

    const response = withDocsPreviewSearchPolicy(immutable, {
      ...resolution,
      renderTarget: "preview",
    });

    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("content-type")).toBe("text/css");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("asset");
  });

  test("does not add a robots policy to production", () => {
    const response = withDocsPreviewSearchPolicy(new Response(), {
      ...resolution,
      renderTarget: "production",
    });

    expect(response.headers.has("x-robots-tag")).toBe(false);
  });

  test("keeps a stricter renderer security header", () => {
    const response = withDocsSecurityHeaders(
      new Response(null, { headers: { "x-frame-options": "DENY" } }),
    );

    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-023): docs HTML never loads plugins or rebases URLs.
describe("docs content security policy", () => {
  test("blocks object, embed and base tags on every gateway response", () => {
    const response = withDocsSecurityHeaders(new Response("<html></html>", { headers: { "content-type": "text/html" } }));

    expect(response.headers.get("content-security-policy")).toBe("base-uri 'self'; object-src 'none'");
  });
});

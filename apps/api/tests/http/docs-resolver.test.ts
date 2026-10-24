import { describe, expect, test, vi } from "vitest";
import type { DocsDomainResolution } from "@doxahq/contracts";
import { DocsResolverClient } from "../../../../packages/contracts/src/docs-resolver";
import { handleDocsResolverRequest } from "../../src/http/docs-resolver";

const site: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public",
  hostname: "demo.doxa.page",
  domainKind: "doxa_subdomain",
  renderTarget: "production",
};

function createResolver() {
  return {
    resolveDocsHost: vi.fn(async (host: string) =>
      host === site.hostname ? site : null,
    ),
    resolveDocsProject: vi.fn(async (id: string) =>
      id === site.projectId ? site : null,
    ),
    resolveDocsSite: vi.fn(async (slug: string) =>
      slug === site.projectSlug ? site : null,
    ),
  };
}

describe("private docs resolver contract", () => {
  test("resolves host metadata through the real HTTP client and handler", async () => {
    const resolver = createResolver();
    const client = new DocsResolverClient({
      fetch: (request) => handleDocsResolverRequest(request, resolver),
    });
    expect(await client.resolveDocsHost("demo.doxa.page")).toEqual(site);
    expect(await client.resolveDocsProject("project-1")).toMatchObject({
      projectId: "project-1",
      publishedVersionId: "version-1",
    });
    expect(await client.resolveDocsSite("demo")).toMatchObject({
      projectSlug: "demo",
    });
    expect(await client.resolveDocsHost("missing.doxa.page")).toBeNull();
    expect(await client.resolveDocsProject("another-project")).toBeNull();
    expect(await client.resolveDocsSite("missing")).toBeNull();
  });

  test.each([
    { label: "unknown operation", body: { kind: "artifact", value: "secret" } },
    { label: "empty identifier", body: { kind: "host", value: " " } },
    {
      label: "extra artifact identity",
      body: {
        kind: "host",
        value: "demo.doxa.page",
        artifactPrefix: "other-project",
      },
    },
    {
      label: "oversized identifier",
      body: { kind: "host", value: "a".repeat(254) },
    },
  ])("rejects $label before resolution", async ({ body }) => {
    const resolver = createResolver();
    const response = await handleDocsResolverRequest(request(body), resolver);
    expect(response.status).toBe(400);
    expect(resolver.resolveDocsHost).not.toHaveBeenCalled();
    expect(resolver.resolveDocsSite).not.toHaveBeenCalled();
    expect(resolver.resolveDocsProject).not.toHaveBeenCalled();
  });

  test("rejects invalid JSON", async () => {
    const response = await handleDocsResolverRequest(
      new Request("https://resolver/resolve", {
        method: "POST",
        body: "{",
      }),
      createResolver(),
    );
    expect(response.status).toBe(400);
  });

  test("rejects unsupported methods", async () => {
    const response = await handleDocsResolverRequest(
      new Request("https://resolver/resolve"),
      createResolver(),
    );
    expect(response.status).toBe(405);
  });

  test("does not expose artifact or generation operations", async () => {
    const response = await handleDocsResolverRequest(
      new Request("https://resolver/internal/docs-artifacts"),
      createResolver(),
    );
    expect(response.status).toBe(404);
  });

  test("does not introduce a second cache", async () => {
    const response = await handleDocsResolverRequest(
      request({ kind: "host", value: site.hostname }),
      createResolver(),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("does not turn a failed database lookup into a missing hostname", async () => {
    const resolver = createResolver();
    resolver.resolveDocsHost.mockRejectedValue(
      new Error("database unavailable"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleDocsResolverRequest(
        request({ kind: "host", value: site.hostname }),
        resolver,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("database unavailable");
    } finally {
      log.mockRestore();
    }
  });

  test.each([404, 500, 503])(
    "client rejects HTTP %i instead of returning null",
    async (status) => {
      const client = new DocsResolverClient({
        fetch: async () => new Response("failure", { status }),
      });
      await expect(client.resolveDocsHost(site.hostname)).rejects.toThrow();
    },
  );

  test("client rejects invalid resolution metadata", async () => {
    const client = new DocsResolverClient({
      fetch: async () => Response.json({ resolution: { projectId: "other" } }),
    });
    await expect(client.resolveDocsHost(site.hostname)).rejects.toThrow();
  });

  test("client sends only the lookup identity with a bounded request", async () => {
    let received: Request | undefined;
    const client = new DocsResolverClient({
      fetch: async (input) => {
        received = input;
        return Response.json({ resolution: null });
      },
    });
    await client.resolveDocsProject("project-1");
    expect(received?.method).toBe("POST");
    expect(new URL(received!.url).pathname).toBe("/resolve");
    expect(await received?.json()).toEqual({
      kind: "project",
      value: "project-1",
    });
    expect(received?.signal).toBeDefined();
  });

  test("client uses a Worker-compatible redirect mode", async () => {
    let received: Request | undefined;
    const client = new DocsResolverClient({
      fetch: async (input) => {
        received = input;
        return Response.json({ resolution: null });
      },
    });

    await client.resolveDocsHost(site.hostname);

    expect(received?.redirect).toBe("manual");
  });
});

function request(body: unknown): Request {
  return new Request("https://resolver/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

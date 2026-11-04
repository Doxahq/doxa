import type { DocsDomainResolution } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

import { handleDocsTryRequest, isDocsTryRequest } from "../src/try-route";

/** SECURITY REGRESSION GUARDRAIL: who can call "Try it", and where the target comes from. */

const resolution = {
  hostname: "acme.doxa.page",
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "acme",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public",
  renderTarget: "production",
} as unknown as DocsDomainResolution;

const ORIGIN = "https://acme.doxa.page";

function sendRequest(init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`${ORIGIN}/__doxa/try`, {
    method: "POST",
    body: '{"v":1}',
    ...init,
    headers: {
      "content-type": "application/vnd.doxa.try+json",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      "cf-connecting-ip": "203.0.113.9",
      ...init.headers,
    },
  });
}

function configRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/__doxa/try/config`, {
    headers: { "sec-fetch-site": "same-origin", ...headers },
  });
}

function makeDependencies(
  features: Record<string, unknown> = {
    apiPlayground: true,
    apiPlaygroundBaseUrl: "https://api.acme.com/v1",
  },
  overrides: Partial<DocsDomainResolution> = {},
) {
  const proxy = {
    config: vi.fn(async () => ({
      mode: "proxy" as const,
      targetHost: "api.acme.com",
      targetBaseUrl: "https://api.acme.com/v1",
      targetId: "target-1",
      limits: { requestBytes: 1, responseBytes: 1, timeoutMs: 1 },
    })),
    send: vi.fn(async () => new Response("answer")),
  };
  return {
    proxy,
    dependencies: {
      resolveHost: vi.fn(async () => ({ ...resolution, ...overrides })),
      runtime: { request: vi.fn(async () => ({ ok: true as const, data: features })) },
      proxy,
    },
  };
}

describe("isDocsTryRequest", () => {
  test.each([
    ["/__doxa/try", true],
    ["/__doxa/try/config", true],
    ["/__doxa/try/", false],
    ["/__doxa/tryit", false],
    ["/guide/__doxa/try", false],
  ])("%s: %s", (path, expected) => {
    expect(isDocsTryRequest(new Request(`${ORIGIN}${path}`))).toBe(expected);
  });
});

describe("the send route", () => {
  test("passes the body on with a context that only the server made", async () => {
    const { dependencies, proxy } = makeDependencies();
    const request = sendRequest();
    const response = await handleDocsTryRequest(request, dependencies);

    expect(await response.text()).toBe("answer");
    expect(proxy.send).toHaveBeenCalledTimes(1);
    const [, context] = proxy.send.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(context).toEqual({
      siteId: "site-1",
      baseUrl: "https://api.acme.com/v1",
      clientKey: "203.0.113.9",
    });
  });

  test("resolves the site from the request host, not from a client value", async () => {
    const { dependencies } = makeDependencies();
    await handleDocsTryRequest(
      sendRequest({ headers: { "x-doxa-site-id": "site-2", host: "other.doxa.page" } }),
      dependencies,
    );
    expect(dependencies.resolveHost).toHaveBeenCalledWith("acme.doxa.page");
  });

  test.each([
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    // `doxa.page` is not on the Public Suffix List, so a tenant is same-site.
    ["same-site", { "sec-fetch-site": "same-site" }],
    ["none", { "sec-fetch-site": "none" }],
    ["another tenant's origin", { origin: "https://evil.doxa.page" }],
    ["plain http origin", { origin: "http://acme.doxa.page" }],
  ])("refuses a call from %s", async (_name, headers) => {
    const { dependencies, proxy } = makeDependencies();
    const response = await handleDocsTryRequest(sendRequest({ headers }), dependencies);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_same_origin" });
    expect(proxy.send).not.toHaveBeenCalled();
  });

  test("refuses a call with no fetch metadata", async () => {
    const { dependencies, proxy } = makeDependencies();
    const request = new Request(`${ORIGIN}/__doxa/try`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/vnd.doxa.try+json", origin: ORIGIN },
    });
    const response = await handleDocsTryRequest(request, dependencies);
    expect(response.status).toBe(403);
    expect(proxy.send).not.toHaveBeenCalled();
  });

  test.each(["text/plain", "application/json", "application/x-www-form-urlencoded"])(
    "refuses the content type %s, which needs no preflight or is not the contract",
    async (contentType) => {
      const { dependencies, proxy } = makeDependencies();
      const response = await handleDocsTryRequest(
        sendRequest({ headers: { "content-type": contentType } }),
        dependencies,
      );
      expect(response.status).toBe(415);
      expect(proxy.send).not.toHaveBeenCalled();
    },
  );

  test("refuses GET", async () => {
    const { dependencies, proxy } = makeDependencies();
    const response = await handleDocsTryRequest(
      new Request(`${ORIGIN}/__doxa/try`, { headers: { "sec-fetch-site": "same-origin" } }),
      dependencies,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(proxy.send).not.toHaveBeenCalled();
  });

  test.each([
    ["a private site", {}, { accessPolicy: "password" }],
    ["the owner's browser choice", { apiPlayground: true, apiPlaygroundBaseUrl: "https://api.acme.com", apiPlaygroundTransport: "browser" }, {}],
    ["a relative base URL", { apiPlayground: true, apiPlaygroundBaseUrl: "/api/echo" }, {}],
    ["a base URL on the docs host", { apiPlayground: true, apiPlaygroundBaseUrl: "https://acme.doxa.page/api" }, {}],
    ["a disabled playground", { apiPlayground: false, apiPlaygroundBaseUrl: "https://api.acme.com" }, {}],
    ["no base URL", { apiPlayground: true }, {}],
  ])("refuses %s", async (_name, features, overrides) => {
    const { dependencies, proxy } = makeDependencies(
      Object.keys(features).length ? features : undefined,
      overrides as Partial<DocsDomainResolution>,
    );
    const response = await handleDocsTryRequest(sendRequest(), dependencies);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "try_off" });
    expect(proxy.send).not.toHaveBeenCalled();
  });

  test("refuses an unknown host", async () => {
    const { dependencies, proxy } = makeDependencies();
    dependencies.resolveHost.mockResolvedValueOnce(null as never);
    const response = await handleDocsTryRequest(sendRequest(), dependencies);
    expect(response.status).toBe(403);
    expect(proxy.send).not.toHaveBeenCalled();
  });

  test("never reads the body, so a key cannot reach dispatcher code", async () => {
    const { dependencies } = makeDependencies();
    const request = sendRequest();
    await handleDocsTryRequest(request, dependencies);
    expect(request.bodyUsed).toBe(false);
  });
});

describe("the config route", () => {
  async function configOf(
    features?: Record<string, unknown>,
    overrides: Partial<DocsDomainResolution> = {},
    withProxy = true,
  ) {
    const { dependencies } = makeDependencies(features, overrides);
    const response = await handleDocsTryRequest(configRequest(), {
      ...dependencies,
      proxy: withProxy ? dependencies.proxy : undefined,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  }

  test("asks the proxy when the site can use it", async () => {
    expect(await configOf()).toMatchObject({ mode: "proxy", targetHost: "api.acme.com" });
  });

  test("answers a preview as it answers the live site", async () => {
    const live = await configOf();
    expect(await configOf(undefined, { renderTarget: "preview" })).toEqual(live);
    expect(await configOf(undefined, { renderTarget: "generation_snapshot" })).toEqual(live);
  });

  test("answers off with no playground", async () => {
    expect(await configOf({ apiPlayground: false })).toEqual({ mode: "off" });
    expect(await configOf({ apiPlayground: true })).toEqual({ mode: "off" });
  });

  test.each([
    ["owner_choice", { apiPlayground: true, apiPlaygroundBaseUrl: "https://api.acme.com", apiPlaygroundTransport: "browser" }, {}],
    ["same_origin", { apiPlayground: true, apiPlaygroundBaseUrl: "/api/echo" }, {}],
    ["private_site", undefined, { accessPolicy: "password" }],
  ])("answers browser for %s", async (reason, features, overrides) => {
    expect(await configOf(features, overrides as Partial<DocsDomainResolution>)).toEqual({
      mode: "browser",
      reason,
    });
  });

  test("answers browser when the proxy is not provisioned", async () => {
    expect(await configOf(undefined, {}, false)).toEqual({
      mode: "browser",
      reason: "proxy_off",
    });
  });

  test("refuses another site's call", async () => {
    const { dependencies } = makeDependencies();
    const response = await handleDocsTryRequest(
      configRequest({ "sec-fetch-site": "cross-site" }),
      dependencies,
    );
    expect(response.status).toBe(403);
  });
});

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

/** SECURITY REGRESSION GUARDRAIL: "Try it" through the real gateway order. */

const ORIGIN = "https://docs.example.com";
const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "artifacts/v1",
  manifestPath: "artifacts/v1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

function makeGateway(send: () => Promise<Response>) {
  const renderer = { fetch: vi.fn(async () => new Response("rendered")) };
  const proxy = { config: vi.fn(), send: vi.fn(send) };
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  const env = {
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
    DOXA_PROD_HTTPS_REDIRECT_MODE: "on",
    DOCS_REQUEST_LIMITER: limiter,
    DOCS_RESOLVER: {},
    DOCS_RUNTIME: {
      request: vi.fn(async () => ({
        ok: true,
        data: { apiPlayground: true, apiPlaygroundBaseUrl: "https://api.acme.com" },
      })),
    },
    SHARED_RENDERER: renderer,
    TRY_PROXY: proxy,
  };
  const ctx = {
    exports: {
      DocsHostCache: () => ({ fetch: async () => Response.json(resolution) }),
    },
    waitUntil: vi.fn(),
  };
  return { env, ctx, proxy, renderer, limiter };
}

function sendRequest(): Request {
  return new Request(`${ORIGIN}/__doxa/try`, {
    method: "POST",
    body: '{"v":1,"method":"GET","path":"/x"}',
    headers: {
      "content-type": "application/vnd.doxa.try+json",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      "cf-connecting-ip": "203.0.113.9",
    },
  });
}

const call = (request: Request, gateway: ReturnType<typeof makeGateway>) =>
  worker.fetch(request, gateway.env as never, gateway.ctx as never);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Try route in the gateway", () => {
  test("answers before the renderer, and keeps the proxy's headers", async () => {
    const gateway = makeGateway(
      async () =>
        new Response("body", {
          headers: {
            "content-type": "application/octet-stream",
            "content-security-policy": "default-src 'none'; sandbox",
            "x-doxa-try-result": "abc",
          },
        }),
    );
    const response = await call(sendRequest(), gateway);

    expect(await response.text()).toBe("body");
    expect(gateway.renderer.fetch).not.toHaveBeenCalled();
    expect(response.headers.get("x-doxa-try-result")).toBe("abc");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toBeTruthy();
  });

  test("applies the per-IP limit first", async () => {
    const gateway = makeGateway(async () => new Response("body"));
    gateway.limiter.limit.mockResolvedValue({ success: false });
    const response = await call(sendRequest(), gateway);

    expect(response.status).toBe(429);
    expect(gateway.proxy.send).not.toHaveBeenCalled();
  });

  test("removes a visitor's x-doxa headers before the route", async () => {
    const gateway = makeGateway(async () => new Response("body"));
    const request = sendRequest();
    request.headers.set("x-doxa-try-result", "forged");
    const response = await call(request, gateway);

    expect(response.headers.get("x-doxa-try-result")).toBeNull();
  });

  test("streams: the answer starts before the target's body ends", async () => {
    let finish: () => void = () => undefined;
    const encoder = new TextEncoder();
    const gateway = makeGateway(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("first"));
              finish = () => {
                controller.enqueue(encoder.encode("-last"));
                controller.close();
              };
            },
          }),
        ),
    );
    const response = await call(sendRequest(), gateway);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("first");
    finish();
    const rest = await reader.read();
    expect(decoder.decode(rest.value)).toBe("-last");
  });
});

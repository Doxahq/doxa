import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ENTRYPOINT_METHODS,
  BRIDGE_KEY_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_REGION_HEADER,
  FORWARD_URL_HEADER,
  ORIGIN_KEY_HEADER,
  PUBLIC_URL_HEADER,
  bridgeCallPath,
  callRemote,
  decodeValue,
  encodeResult,
} from "@doxahq/api-bridge";
import type { EdgeEnv } from "../src/env";
import wranglerConfig from "../wrangler.json";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

const edge = await import("../src/index");
const { VPC_ORIGIN_BASE_URL } = await import("../src/origin");
const worker = edge.default;

const ORIGIN_KEY = "o".repeat(40);
const BRIDGE_KEY = "b".repeat(40);

type Respond = (request: Request) => Response | Promise<Response>;

/** An origin VPC Service binding, which records the requests that the Worker sends through it. */
function stubOrigin(respond: Respond = () => new Response("ok")) {
  const requests: Request[] = [];
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    },
  } as Fetcher;
  return { binding, requests };
}

/** The env of an edge that sends its traffic to this binding, as the blue origin. */
function liveOrigin(binding: Fetcher): Partial<EdgeEnv> {
  return { ORIGIN_BLUE: binding, ORIGIN_GREEN: stubOrigin(() => new Response("idle color")).binding, ORIGIN_COLOR: "blue" };
}

/** A production env: the origin is the blue binding, and ORIGIN_URL is not set. */
function createEnv(overrides: Partial<EdgeEnv> = {}): EdgeEnv {
  return {
    ...liveOrigin(stubOrigin().binding),
    ORIGIN_SHARED_SECRET: ORIGIN_KEY,
    BRIDGE_SHARED_SECRET: BRIDGE_KEY,
    GENERATION_QUEUE: { send: vi.fn(async () => ({})), sendBatch: vi.fn(), metrics: vi.fn() },
    ...overrides,
  } as EdgeEnv;
}

/** A development env: the origin is the local Node server at ORIGIN_URL. */
function developmentEnv(overrides: Partial<EdgeEnv> = {}): EdgeEnv {
  return createEnv({ ORIGIN_BLUE: undefined, ORIGIN_GREEN: undefined, ORIGIN_COLOR: undefined, ORIGIN_URL: "http://localhost:8786", ...overrides });
}

/** Records the requests that the Worker sends with global fetch. */
function stubFetch(respond: Respond) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An execution context whose waitUntil promises the test can await. Tests use waitUntil only. */
function executionContext(pending: Promise<unknown>[] = []): ExecutionContext {
  const context: Pick<ExecutionContext, "waitUntil" | "passThroughOnException" | "props"> = {
    waitUntil: (promise) => void pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  };
  return context as ExecutionContext;
}

describe("origin", () => {
  it("sends development requests to the local origin with global fetch", async () => {
    const requests = stubFetch(() => new Response("ok"));

    await worker.fetch(new Request("https://api.doxa.so/me?x=1"), developmentEnv());

    expect(requests[0]!.url).toBe("http://localhost:8786/me?x=1");
    expect(requests[0]!.headers.get(ORIGIN_KEY_HEADER)).toBe(ORIGIN_KEY);
  });

  it("refuses an ORIGIN_URL that is not a loopback URL, so the key stays on this machine", async () => {
    const requests = stubFetch(() => new Response("must not happen"));
    const unsafe = [
      "https://origin-api.doxa.so",
      "http://localhost.evil.example",
      "http://127.0.0.1.nip.io:8786",
      "http://10.0.0.5:8786",
      "http://user@evil.example",
      "http://localhost:8786/base",
      "http://localhost:8786?x=1",
      "ftp://localhost",
      "not a url",
      "",
    ];

    for (const value of unsafe) {
      await expect(worker.fetch(new Request("https://api.doxa.so/me"), developmentEnv({ ORIGIN_URL: value })), value).rejects.toThrow(
        /ORIGIN_URL must be a loopback URL/,
      );
    }
    for (const value of ["http://127.0.0.1:8786", "http://[::1]:8786", "https://localhost:8443/"]) {
      await worker.fetch(new Request("https://api.doxa.so/me"), developmentEnv({ ORIGIN_URL: value }));
    }
    expect(requests).toHaveLength(3);
  });

  it("refuses to run with both origin bindings and ORIGIN_URL, or with neither", async () => {
    const origin = stubOrigin();
    const requests = stubFetch(() => new Response("must not happen"));

    await expect(
      worker.fetch(new Request("https://api.doxa.so/me"), createEnv({ ...liveOrigin(origin.binding), ORIGIN_URL: "http://localhost:8786" })),
    ).rejects.toThrow(/origin bindings and ORIGIN_URL/);
    await expect(
      worker.fetch(new Request("https://api.doxa.so/me"), createEnv({ ORIGIN_BLUE: undefined, ORIGIN_GREEN: undefined })),
    ).rejects.toThrow(/no origin/);

    expect(origin.requests).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("sends the traffic to the color that ORIGIN_COLOR names", async () => {
    const blue = stubOrigin(() => new Response("blue"));
    const green = stubOrigin(() => new Response("green"));
    const env = (color: string) => createEnv({ ORIGIN_BLUE: blue.binding, ORIGIN_GREEN: green.binding, ORIGIN_COLOR: color });

    expect(await (await worker.fetch(new Request("https://api.doxa.so/me"), env("green"))).text()).toBe("green");
    expect(await (await worker.fetch(new Request("https://api.doxa.so/me"), env("blue"))).text()).toBe("blue");
    expect(blue.requests).toHaveLength(1);
    expect(green.requests).toHaveLength(1);
  });

  it("refuses a missing or unknown ORIGIN_COLOR, and a color without its binding", async () => {
    const blue = stubOrigin();
    const request = () => new Request("https://api.doxa.so/me");

    for (const color of [undefined, "", "red", "toString"]) {
      await expect(worker.fetch(request(), createEnv({ ORIGIN_COLOR: color })), String(color)).rejects.toThrow(/ORIGIN_COLOR must be blue or green/);
    }
    await expect(
      worker.fetch(request(), createEnv({ ORIGIN_BLUE: blue.binding, ORIGIN_GREEN: undefined, ORIGIN_COLOR: "green" })),
    ).rejects.toThrow(/no ORIGIN_GREEN binding/);
    expect(blue.requests).toHaveLength(0);
  });

  it("sends its release to the origin with every request, and drops a client's", async () => {
    const origin = stubOrigin(() => new Response(encodeResult({ ok: true, value: null }), { status: 202 }));
    const env = createEnv({ ...liveOrigin(origin.binding), DOXA_RELEASE_ID: "0123456789ab" });

    await worker.fetch(new Request("https://api.doxa.so/me", { headers: { "x-doxa-release": "forged" } }), env);
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: 0, cron: "*/5 * * * *", noRetry: () => {} } as ScheduledController, env, executionContext(pending));
    await Promise.all(pending);

    expect(origin.requests.map((sent) => sent.headers.get("x-doxa-release"))).toEqual(["0123456789ab", "0123456789ab"]);
  });

  it("serves production on api.doxa.so only, with no workers.dev or preview URL", () => {
    const production = wranglerConfig.env.production;

    expect(production.routes).toEqual([{ pattern: "api.doxa.so", custom_domain: true }]);
    expect(production.workers_dev).toBe(false);
    expect(production.preview_urls).toBe(false);
  });

  it("binds the origin VPC Service in production only, never as a remote binding in development", () => {
    const production = wranglerConfig.env.production;

    expect(production.vpc_services).toEqual([
      { binding: "ORIGIN_BLUE", service_id: expect.any(String) },
      { binding: "ORIGIN_GREEN", service_id: expect.any(String) },
    ]);
    // The release names the live color on each version; a config default would send traffic to a stopped color.
    expect(production.vars).not.toHaveProperty("ORIGIN_COLOR");
    expect(production).not.toHaveProperty("vars.ORIGIN_URL");
    expect(wranglerConfig).not.toHaveProperty("vpc_services");
    expect(wranglerConfig.vars.ORIGIN_URL).toBe("http://localhost:8786");
  });
});

/** A request as Cloudflare delivers it, with `request.cf`. */
function withCf(request: Request, cf: Record<string, unknown>): Request {
  Object.defineProperty(request, "cf", { value: cf });
  return request;
}

describe("public proxy", () => {
  it("sends the request through the origin binding with the key, the public URL and the client IP", async () => {
    const origin = stubOrigin();
    const publicFetch = stubFetch(() => new Response("must not happen"));
    const request = new Request("https://api.doxa.so/projects?x=1", {
      method: "POST",
      body: "{}",
      headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
    });

    const response = await worker.fetch(request, createEnv(liveOrigin(origin.binding)));

    expect(await response.text()).toBe("ok");
    expect(publicFetch).toHaveLength(0);
    const sent = origin.requests[0]!;
    expect(sent.url).toBe(`${VPC_ORIGIN_BASE_URL}/projects?x=1`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get(ORIGIN_KEY_HEADER)).toBe(ORIGIN_KEY);
    expect(sent.headers.get(PUBLIC_URL_HEADER)).toBe("https://api.doxa.so/projects?x=1");
    expect(sent.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
    expect(await sent.text()).toBe("{}");
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-003): the edge stops oversized bodies.
  it("refuses a declared body above the edge limit without calling the origin", async () => {
    const { binding, requests } = stubOrigin();
    const { EDGE_MAX_BODY_BYTES } = await import("../src/proxy");

    const response = await worker.fetch(
      new Request("https://api.doxa.so/github/webhook", {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(EDGE_MAX_BODY_BYTES + 1) },
      }),
      createEnv(liveOrigin(binding)),
    );

    expect(response.status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  it("forwards a chunked body below the edge limit", async () => {
    const { binding, requests } = stubOrigin();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}'));
        controller.close();
      },
    });

    const response = await worker.fetch(
      new Request("https://api.doxa.so/projects", { method: "POST", body, duplex: "half" } as RequestInit),
      createEnv(liveOrigin(binding)),
    );

    expect(response.status).toBe(200);
    expect(await requests[0]!.text()).toBe('{"a":1}');
  });

  it("drops edge headers that a client sets", async () => {
    const { binding, requests } = stubOrigin();

    await worker.fetch(
      new Request("https://api.doxa.so/me", { headers: { [ORIGIN_KEY_HEADER]: "forged", [PUBLIC_URL_HEADER]: "https://evil.example/" } }),
      createEnv(liveOrigin(binding)),
    );

    expect(requests[0]!.headers.get(ORIGIN_KEY_HEADER)).toBe(ORIGIN_KEY);
    expect(requests[0]!.headers.get(PUBLIC_URL_HEADER)).toBe("https://api.doxa.so/me");
  });

  it("sets the client's cache pool from request.cf, and drops one that the client sends", async () => {
    const { binding, requests } = stubOrigin();
    const request = withCf(
      new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "oceania" } }),
      { colo: "CDG", country: "FR" },
    );

    await worker.fetch(request, createEnv(liveOrigin(binding)));

    expect(requests[0]!.headers.get(CLIENT_REGION_HEADER)).toBe("eu-west");
  });

  it("sends no cache pool when the location is unknown, even when the client sends one", async () => {
    const { binding, requests } = stubOrigin();

    await worker.fetch(
      withCf(new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "us-east" } }), { country: "IN", continent: "AS" }),
      createEnv(liveOrigin(binding)),
    );
    await worker.fetch(
      new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "us-east" } }),
      createEnv(liveOrigin(binding)),
    );

    expect(requests.map((sent) => sent.headers.get(CLIENT_REGION_HEADER))).toEqual([null, null]);
  });

  it("keeps the origin host for a path that starts with two slashes, so the key never leaves", async () => {
    const origin = stubOrigin();
    const local = stubFetch(() => new Response("ok"));
    const paths = ["//evil.example/steal?x=1", "///evil.example/", "/\\evil.example/x"];

    for (const path of paths) {
      await worker.fetch(new Request(`https://api.doxa.so${path}`), createEnv(liveOrigin(origin.binding)));
      await worker.fetch(new Request(`https://api.doxa.so${path}`), developmentEnv());
    }

    for (const sent of origin.requests) {
      expect(new URL(sent.url).host, sent.url).toBe(new URL(VPC_ORIGIN_BASE_URL).host);
    }
    for (const sent of local) {
      expect(new URL(sent.url).host, sent.url).toBe("localhost:8786");
    }
    expect(origin.requests).toHaveLength(3);
    expect(local).toHaveLength(3);
  });

  it("does not forward the client's Host header", async () => {
    const { binding, requests } = stubOrigin();

    await worker.fetch(new Request("https://api.doxa.so/me", { headers: { host: "api.doxa.so" } }), createEnv(liveOrigin(binding)));

    expect(requests[0]!.headers.get("host")).toBeNull();
  });

  it("never proxies the origin's internal routes", async () => {
    const { binding, requests } = stubOrigin(() => new Response("must not happen"));

    for (const path of ["/__rpc/InternalApi/addJobEvent", "/__cron", "/__anything"]) {
      const response = await worker.fetch(new Request(`https://api.doxa.so${path}`, { method: "POST" }), createEnv(liveOrigin(binding)));
      expect(response.status, path).toBe(404);
    }
    expect(requests).toHaveLength(0);
  });
});

describe("bridge", () => {
  const bridgeCall = (env: EdgeEnv, binding: string, method: string, args: unknown[], key = BRIDGE_KEY) =>
    callRemote(
      {
        fetch: (request) => worker.fetch(request, env),
        url: `https://api.doxa.so${bridgeCallPath(binding, method)}`,
        keyHeader: BRIDGE_KEY_HEADER,
        key,
      },
      args,
    );

  it("calls a listed binding method with the origin's arguments", async () => {
    const env = createEnv();

    await bridgeCall(env, "GENERATION_QUEUE", "send", [{ jobId: "job-1" }, { delaySeconds: 5 }]);

    expect(env.GENERATION_QUEUE.send).toHaveBeenCalledWith({ jobId: "job-1" }, { delaySeconds: 5 });
  });

  it("returns the value of an RPC binding method", async () => {
    const inspect = vi.fn(async () => ({ status: "complete" }));
    const env = createEnv({ PRERENDER_QUEUE: { inspect } as unknown as Service });

    await expect(bridgeCall(env, "PRERENDER_QUEUE", "inspect", [{ identity: "x" }])).resolves.toEqual({ status: "complete" });
  });

  it("refuses a wrong key, an unlisted method and an unlisted binding", async () => {
    const env = createEnv();

    await expect(bridgeCall(env, "GENERATION_QUEUE", "send", [], "w".repeat(40))).rejects.toThrow(/HTTP 401/);
    await expect(bridgeCall(env, "GENERATION_QUEUE", "metrics", [])).rejects.toThrow(/HTTP 404/);
    await expect(bridgeCall(env, "DOCS_BUCKET", "get", [])).rejects.toThrow(/HTTP 404/);
    expect(env.GENERATION_QUEUE.send).not.toHaveBeenCalled();
  });

  it("forwards the docs dispatcher's warm status call", async () => {
    const status = { siteId: "site-1", releaseId: null, startedAt: null, finishedAt: null, pools: [] };
    const getWarmStatus = vi.fn(async () => status);
    const env = createEnv({ DOCS_CACHE_INVALIDATOR: { getWarmStatus } as unknown as Service });

    await expect(bridgeCall(env, "DOCS_CACHE_INVALIDATOR", "getWarmStatus", [{ siteId: "site-1" }])).resolves.toEqual(status);
    expect(getWarmStatus).toHaveBeenCalledWith({ siteId: "site-1" });
  });

  it("fails the warm status call when the dispatcher has no such method", async () => {
    const env = createEnv({ DOCS_CACHE_INVALIDATOR: { invalidate: vi.fn() } as unknown as Service });

    await expect(bridgeCall(env, "DOCS_CACHE_INVALIDATOR", "getWarmStatus", [{ siteId: "site-1" }])).rejects.toThrow(/not a method/);
  });

  it("forwards a fetch to the agent container at the forward URL", async () => {
    const containerFetch = vi.fn(async (request: Request) => new Response(`${request.method} ${request.url}`));
    const env = createEnv({ AGENT_CONTAINER: { fetch: containerFetch } as unknown as Fetcher });

    const response = await worker.fetch(
      new Request("https://api.doxa.so/__bridge/fetch/AGENT_CONTAINER", {
        method: "POST",
        body: "{}",
        headers: { [BRIDGE_KEY_HEADER]: BRIDGE_KEY, [FORWARD_URL_HEADER]: "https://container/cancel" },
      }),
      env,
    );

    expect(await response.text()).toBe("POST https://container/cancel");
    const forwarded = containerFetch.mock.calls[0]![0];
    expect(forwarded.headers.get(BRIDGE_KEY_HEADER)).toBeNull();
  });
});

describe("RPC entrypoints", () => {
  it("expose exactly the API methods, and forward each call to the origin", async () => {
    const { binding, requests } = stubOrigin(() => new Response(encodeResult({ ok: true, value: { active: true } })));
    const env = createEnv(liveOrigin(binding));

    for (const [name, methods] of Object.entries(API_ENTRYPOINT_METHODS)) {
      const entrypoint = Reflect.get(edge, name);
      expect(Object.getOwnPropertyNames(entrypoint.prototype).filter((key) => key !== "constructor").sort(), name).toEqual(
        [...methods].sort(),
      );
    }

    const internal: object = Reflect.construct(edge.InternalApi, [executionContext(), env]);
    const result = await Reflect.apply(Reflect.get(internal, "isJobActive"), internal, ["job-1"]);

    expect(result).toEqual({ active: true });
    expect(requests[0]!.url).toBe(`${VPC_ORIGIN_BASE_URL}/__rpc/InternalApi/isJobActive`);
    expect(requests[0]!.headers.get(ORIGIN_KEY_HEADER)).toBe(ORIGIN_KEY);
    expect(decodeValue(await requests[0]!.text())).toEqual(["job-1"]);
  });
});

describe("cron", () => {
  it("sends the tick to the origin", async () => {
    const { binding, requests } = stubOrigin(() => new Response(null, { status: 202 }));
    const pending: Promise<unknown>[] = [];

    await worker.scheduled(
      { scheduledTime: 1_700_000_000_000, cron: "*/5 * * * *", noRetry: () => {} },
      createEnv(liveOrigin(binding)),
      executionContext(pending),
    );
    await Promise.all(pending);

    expect(requests[0]!.url).toBe(`${VPC_ORIGIN_BASE_URL}/__cron`);
    await expect(requests[0]!.json()).resolves.toEqual({ scheduledTime: 1_700_000_000_000 });
  });

  it("fails the tick when the origin refuses it", async () => {
    const { binding } = stubOrigin(() => new Response("Unauthorized.", { status: 401 }));
    const pending: Promise<unknown>[] = [];

    await worker.scheduled(
      { scheduledTime: 1, cron: "*/5 * * * *", noRetry: () => {} },
      createEnv(liveOrigin(binding)),
      executionContext(pending),
    );

    await expect(Promise.all(pending)).rejects.toThrow(/HTTP 401/);
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-008): per-IP limits before the origin.
describe("public rate limits", () => {
  function limiter(success: boolean) {
    return { limit: vi.fn(async () => ({ success })) };
  }

  function env(overrides: Partial<EdgeEnv> = {}) {
    const origin = stubOrigin();
    return {
      origin,
      env: createEnv({
        ...liveOrigin(origin.binding),
        API_OAUTH_REGISTER_LIMITER: limiter(true) as never,
        API_OAUTH_LIMITER: limiter(true) as never,
        API_PUBLIC_LIMITER: limiter(true) as never,
        ...overrides,
      }),
    };
  }

  function from(ip: string, url: string, init: RequestInit = {}) {
    return new Request(url, { ...init, headers: { "cf-connecting-ip": ip, ...(init.headers ?? {}) } });
  }

  it("answers 429 for client registration over the limit, without calling the origin", async () => {
    const register = limiter(false);
    const { env: e, origin } = env({ API_OAUTH_REGISTER_LIMITER: register as never });

    const response = await worker.fetch(
      from("203.0.113.9", "https://api.doxa.so/oauth/register", { method: "POST", body: "{}" }),
      e,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(register.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(origin.requests).toHaveLength(0);
  });

  it("gives agent registration its own budget, and answers 429 at the limit", async () => {
    const identity = limiter(false);
    const publicLimit = limiter(true);
    const { env: e, origin } = env({ API_AGENT_IDENTITY_LIMITER: identity as never, API_PUBLIC_LIMITER: publicLimit as never });

    const response = await worker.fetch(from("203.0.113.9", "https://api.doxa.so/agent/identity", { method: "POST", body: "{}" }), e);

    expect(response.status).toBe(429);
    expect(identity.limit).toHaveBeenCalledTimes(1);
    expect(publicLimit.limit).not.toHaveBeenCalled();
    expect(origin.requests).toHaveLength(0);
  });

  it("uses the OAuth budget for the other OAuth endpoints and the public budget elsewhere", async () => {
    const oauth = limiter(true);
    const publicLimit = limiter(true);
    const { env: e } = env({ API_OAUTH_LIMITER: oauth as never, API_PUBLIC_LIMITER: publicLimit as never });

    await worker.fetch(from("203.0.113.9", "https://api.doxa.so/oauth/token", { method: "POST", body: "x" }), e);
    await worker.fetch(from("203.0.113.9", "https://api.doxa.so/projects"), e);

    expect(oauth.limit).toHaveBeenCalledTimes(1);
    expect(publicLimit.limit).toHaveBeenCalledTimes(1);
  });

  it("does not count GET /me, which the web Worker sends from a shared IP", async () => {
    const publicLimit = limiter(false);
    const { env: e, origin } = env({ API_PUBLIC_LIMITER: publicLimit as never });

    const response = await worker.fetch(from("2a06:98c0::1", "https://api.doxa.so/me"), e);

    expect(response.status).toBe(200);
    expect(publicLimit.limit).not.toHaveBeenCalled();
    expect(origin.requests).toHaveLength(1);
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-008): one IPv6 client cannot rotate through its /64.
describe("client IP rate-limit key", () => {
  it("keys IPv4 by address and IPv6 by /64 prefix", async () => {
    const { clientIpRateLimitKey } = await import("@doxahq/contracts/client-ip");
    expect(clientIpRateLimitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientIpRateLimitKey("2001:db8:abcd:12:1::1")).toBe("2001:db8:abcd:12::/64");
    expect(clientIpRateLimitKey("2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff")).toBe("2001:db8:abcd:12::/64");
    expect(clientIpRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientIpRateLimitKey("::ffff:203.0.113.9")).toBe("0:0:0:0::/64");
  });

  it("does not count CORS preflights or GitHub webhooks", async () => {
    const publicLimit = { limit: vi.fn(async () => ({ success: false })) };
    const { binding } = stubOrigin();
    const env = createEnv({ ...liveOrigin(binding), API_PUBLIC_LIMITER: publicLimit as never });

    const preflight = await worker.fetch(
      new Request("https://api.doxa.so/projects", { method: "OPTIONS", headers: { "cf-connecting-ip": "203.0.113.9" } }),
      env,
    );
    const webhook = await worker.fetch(
      new Request("https://api.doxa.so/github/webhook", {
        method: "POST",
        body: "{}",
        headers: { "cf-connecting-ip": "140.82.112.1", "content-length": "2" },
      }),
      env,
    );

    expect(preflight.status).not.toBe(429);
    expect(webhook.status).not.toBe(429);
    expect(publicLimit.limit).not.toHaveBeenCalled();
  });
});

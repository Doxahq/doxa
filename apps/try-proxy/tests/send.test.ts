import {
  DOCS_TRY_LIMITS,
  DOCS_TRY_RESULT_HEADER,
  decodeDocsTryResult,
  type DocsTryContext,
  type DocsTryProblem,
} from "@doxahq/contracts/docs-try";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { TryProxyEnv } from "../src/env";
import { readTryConfig, sendTryRequest } from "../src/send";
import { TRY_USER_AGENT } from "../src/target-request";
import { classifyCloudflareFailure, limitBody } from "../src/target-response";

/** SECURITY REGRESSION GUARDRAIL: what the proxy sends, refuses and returns. */

const context: DocsTryContext = {
  siteId: "site-1",
  baseUrl: "https://api.acme.com/v1",
  clientKey: "203.0.113.9",
};

function makeEnv(overrides: Partial<TryProxyEnv> = {}) {
  const budgetTake = vi.fn(async () => true);
  const limit = () => vi.fn(async () => ({ success: true }));
  const metrics = { writeDataPoint: vi.fn() };
  const env = {
    TRY_CLIENT: { limit: limit() },
    TRY_SITE: { limit: limit() },
    TRY_TARGET: { limit: limit() },
    TRY_BUDGET: {
      idFromName: (name: string) => name,
      get: () => ({ take: budgetTake }),
    },
    TRY_METRICS: metrics,
    DOXA_PROD_TRY_PROXY_MODE: "all",
    DOXA_TRY_RESERVED_ZONES: "doxa.so,doxa.page",
    ...overrides,
  } as unknown as TryProxyEnv;
  return { env, budgetTake, metrics };
}

function bodyOf(value: unknown): ReadableStream<Uint8Array> {
  return new Response(typeof value === "string" ? value : JSON.stringify(value))
    .body as ReadableStream<Uint8Array>;
}

const acmeConfig = await readTryConfig(makeEnv().env, context);
if (acmeConfig.mode !== "proxy") throw new Error("expected proxy mode");

const goodRequest = {
  v: 1,
  targetId: acmeConfig.targetId,
  method: "POST",
  path: "/notes",
  query: [["limit", "10"]],
  headers: [["x-api-key", "secret"]],
  cookies: [],
  body: { encoding: "utf8", data: '{"a":1}' },
};

async function problemOf(response: Response): Promise<DocsTryProblem> {
  expect(response.headers.get(DOCS_TRY_RESULT_HEADER)).toBeNull();
  return (await response.json()) as DocsTryProblem;
}

let targetFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  targetFetch = vi.fn(async () => new Response('{"ok":true}', {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", targetFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendTryRequest: a good send", () => {
  test("builds the URL from the owner's base URL and the request path", async () => {
    const { env } = makeEnv();
    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    const [url, init] = targetFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.acme.com/v1/notes?limit=10");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
  });

  test("a body at the limit goes out, when JSON escapes make its envelope six times larger", async () => {
    const { env } = makeEnv();
    const data = "\0".repeat(DOCS_TRY_LIMITS.requestBytes);
    const response = await sendTryRequest({
      env,
      body: bodyOf({ ...goodRequest, body: { encoding: "utf8", data } }),
      context,
    });

    expect(response.headers.get(DOCS_TRY_RESULT_HEADER)).not.toBeNull();
    expect(targetFetch.mock.calls[0]![1].body).toBe(data);
  });

  test("never follows a redirect and never caches", async () => {
    const { env } = makeEnv();
    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    const [, init] = targetFetch.mock.calls[0]!;
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
  });

  test("sends only the reader's headers and the Doxa identity", async () => {
    const { env } = makeEnv();
    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    const headers = new Headers(targetFetch.mock.calls[0]![1].headers);
    expect(Object.fromEntries(headers)).toEqual({
      "user-agent": TRY_USER_AGENT,
      "x-api-key": "secret",
      "x-doxa-try-site": "site-1",
    });
  });

  test("returns the raw body, with the target's answer in the result header", async () => {
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    const result = decodeDocsTryResult(response.headers.get(DOCS_TRY_RESULT_HEADER)!);
    expect(result?.status).toBe(201);
    expect(result?.statusText).toBe("Created");
    expect(result?.headers).toContainEqual(["content-type", "application/json"]);
  });

  test("keeps a target 401 as a result, not as a refusal", async () => {
    targetFetch.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect(response.status).toBe(200);
    expect(decodeDocsTryResult(response.headers.get(DOCS_TRY_RESULT_HEADER)!)?.status).toBe(401);
  });

  test("gives the docs origin no target header that can act on it", async () => {
    targetFetch.mockResolvedValueOnce(
      new Response("<script>alert(1)</script>", {
        headers: {
          "content-type": "text/html",
          "set-cookie": "stolen=1",
          "access-control-allow-origin": "*",
        },
      }),
    );
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const result = decodeDocsTryResult(response.headers.get(DOCS_TRY_RESULT_HEADER)!);
    expect(result?.headers).toContainEqual(["set-cookie", "stolen=1"]);
  });

  test("reports a redirect and says if it stays on the target", async () => {
    const { env } = makeEnv();
    targetFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "/v1/other" } }),
    );
    let response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect(decodeDocsTryResult(response.headers.get(DOCS_TRY_RESULT_HEADER)!)?.redirect).toEqual({
      location: "https://api.acme.com/v1/other",
      sameTarget: true,
    });
    expect(targetFetch).toHaveBeenCalledTimes(1);

    targetFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect(decodeDocsTryResult(response.headers.get(DOCS_TRY_RESULT_HEADER)!)?.redirect).toEqual({
      location: "https://evil.example/",
      sameTarget: false,
    });
  });

  test("truncates the result header instead of failing on large headers", async () => {
    const headers = new Headers();
    for (let index = 0; index < 40; index += 1) {
      headers.set(`x-large-${index}`, "x".repeat(4_000));
    }
    targetFetch.mockResolvedValueOnce(new Response("ok", { headers }));
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    const value = response.headers.get(DOCS_TRY_RESULT_HEADER)!;
    expect(value.length).toBeLessThanOrEqual(64 * 1024);
    expect(decodeDocsTryResult(value)?.headersTruncated).toBe(true);
  });

  test("records metrics with no path, query, header or body", async () => {
    const { env, metrics } = makeEnv();
    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    const point = JSON.stringify(metrics.writeDataPoint.mock.calls[0]![0]);
    expect(point).toContain("api.acme.com");
    expect(point).not.toContain("secret");
    expect(point).not.toContain("/notes");
    expect(point).not.toContain("limit");
  });
});

describe("sendTryRequest: refusals never reach the target", () => {
  afterEach(() => {
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test.each([
    ["off", undefined],
    ["off", "off"],
    ["off", "something else"],
  ])("the kill switch: %s (%s)", async (_name, mode) => {
    const { env } = makeEnv({ DOXA_PROD_TRY_PROXY_MODE: mode } as Partial<TryProxyEnv>);
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect((await problemOf(response)).code).toBe("try_off");
    expect(response.status).toBe(403);
  });

  test("a site outside the allowlist", async () => {
    const { env } = makeEnv({
      DOXA_PROD_TRY_PROXY_MODE: "allowlist",
      DOXA_PROD_TRY_PROXY_SITE_IDS: "site-2,site-3",
    });
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect((await problemOf(response)).code).toBe("try_off");
  });

  test.each([
    "https://169.254.169.254",
    "https://localhost",
    "http://api.acme.com",
    "https://acme.doxa.page",
    "/api/echo",
  ])("a base URL that fails the target rules: %s", async (baseUrl) => {
    const { env } = makeEnv();
    const response = await sendTryRequest({
      env,
      body: bodyOf(goodRequest),
      context: { ...context, baseUrl },
    });
    expect((await problemOf(response)).code).toBe("target_blocked");
  });

  test.each(["api.acme.com", "acme.com", " ACME.com "])(
    "a host on the blocklist: %s",
    async (entry) => {
      const { env } = makeEnv({ DOXA_TRY_BLOCKED_HOSTS: `other.example,${entry}` });
      const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
      expect((await problemOf(response)).code).toBe("target_blocked");
    },
  );

  test.each([
    ["url", { ...goodRequest, url: "https://evil.example" }],
    ["host", { ...goodRequest, host: "evil.example" }],
    ["baseUrl", { ...goodRequest, baseUrl: "https://evil.example" }],
    ["wrong version", { ...goodRequest, v: 2 }],
    ["unknown method", { ...goodRequest, method: "TRACE" }],
    ["GET with a body", { ...goodRequest, method: "GET" }],
    ["HEAD with a body", { ...goodRequest, method: "HEAD" }],
    ["base64 body", { ...goodRequest, body: { encoding: "base64", data: "AA==" } }],
    ["missing path", { v: 1, method: "GET" }],
  ])("a request that fails the strict schema: %s", async (_name, request) => {
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(request), context });
    expect((await problemOf(response)).code).toBe("invalid_request");
    expect(response.status).toBe(400);
  });

  test("a body that is not JSON", async () => {
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf("not json"), context });
    expect((await problemOf(response)).code).toBe("invalid_request");
  });

  test("no body at all", async () => {
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: null, context });
    expect((await problemOf(response)).code).toBe("invalid_request");
  });

  test("a body over the limit", async () => {
    const { env } = makeEnv();
    const request = { ...goodRequest, body: { encoding: "utf8", data: "x".repeat(2_100_000) } };
    const response = await sendTryRequest({ env, body: bodyOf(request), context });
    expect((await problemOf(response)).code).toBe("body_too_large");
    expect(response.status).toBe(413);
  });

  test("an envelope far over the limit stops early", async () => {
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf("x".repeat(13_000_000)), context });
    expect((await problemOf(response)).code).toBe("body_too_large");
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("one byte over the limit is refused, also with escapes", async () => {
    const { env } = makeEnv();
    const data = "\0".repeat(DOCS_TRY_LIMITS.requestBytes + 1);
    const response = await sendTryRequest({
      env,
      body: bodyOf({ ...goodRequest, body: { encoding: "utf8", data } }),
      context,
    });

    expect((await problemOf(response)).code).toBe("body_too_large");
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("a path that leaves the base path", async () => {
    const { env } = makeEnv();
    const response = await sendTryRequest({
      env,
      body: bodyOf({ ...goodRequest, path: "/../admin" }),
      context,
    });
    expect((await problemOf(response)).code).toBe("path_refused");
  });

  test("a denied header, by name", async () => {
    const { env } = makeEnv();
    const response = await sendTryRequest({
      env,
      body: bodyOf({ ...goodRequest, headers: [["Host", "evil.example"]] }),
      context,
    });
    const problem = await problemOf(response);
    expect(problem.code).toBe("header_refused");
    expect(problem.title).toContain("Host");
  });

  test.each(["TRY_CLIENT", "TRY_SITE", "TRY_TARGET"] as const)(
    "the %s rate limit",
    async (binding) => {
      const { env } = makeEnv();
      (env[binding] as { limit: unknown }).limit = vi.fn(async () => ({ success: false }));
      const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
      const problem = await problemOf(response);
      expect(problem.code).toBe("rate_limited");
      expect(problem.retryAfter).toBe(60);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
    },
  );

  test("the daily budget, until the next UTC day", async () => {
    const { env, budgetTake } = makeEnv();
    budgetTake.mockResolvedValue(false);
    const response = await sendTryRequest({
      env,
      body: bodyOf(goodRequest),
      context,
      now: () => Date.UTC(2026, 10, 3, 23, 59, 0),
    });
    const problem = await problemOf(response);
    expect(problem.code).toBe("rate_limited");
    expect(problem.retryAfter).toBe(60);
  });
});

describe("sendTryRequest: limits", () => {
  test("keys the limits by site and client, by site, and by target host", async () => {
    const { env } = makeEnv();
    await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect(env.TRY_CLIENT.limit).toHaveBeenCalledWith({ key: "site-1:203.0.113.9" });
    expect(env.TRY_SITE.limit).toHaveBeenCalledWith({ key: "site-1" });
    expect(env.TRY_TARGET.limit).toHaveBeenCalledWith({ key: "api.acme.com" });
  });

  test("a storage fault in the budget does not stop a send", async () => {
    const { env, budgetTake } = makeEnv();
    budgetTake.mockRejectedValue(new Error("storage"));
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect(response.headers.get(DOCS_TRY_RESULT_HEADER)).not.toBeNull();
  });
});

describe("sendTryRequest: failures of the target", () => {
  // The values that a spike measured on Cloudflare on 2026-11-03.
  test.each([
    [530, "error code: 1016\n", "target_dns", 502],
    [526, "error code: 526\n", "target_tls", 502],
    [525, "error code: 525\n", "target_tls", 502],
    [403, "error code: 1003\n", "target_refused", 502],
    [522, "error code: 522\n", "target_refused", 502],
    [524, "error code: 524\n", "target_timeout", 504],
  ])("maps Cloudflare's %i %j to %s", async (status, text, code, outerStatus) => {
    targetFetch.mockResolvedValueOnce(
      new Response(text, { status, headers: { "content-type": "text/plain; charset=UTF-8" } }),
    );
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect((await problemOf(response)).code).toBe(code);
    expect(response.status).toBe(outerStatus);
  });

  test.each([
    [403, "text/plain", "Forbidden: your plan has no access"],
    [403, "application/json", '{"error":"error code: 1003"}'],
    [530, "text/html", "<h1>error code: 1016</h1>"],
  ])("keeps an API's own %i %s as its answer", async (status, contentType, text) => {
    targetFetch.mockResolvedValueOnce(
      new Response(text, { status, headers: { "content-type": contentType } }),
    );
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect(decodeDocsTryResult(response.headers.get(DOCS_TRY_RESULT_HEADER)!)?.status).toBe(status);
    expect(await response.text()).toBe(text);
  });

  test("maps a thrown connection error", async () => {
    targetFetch.mockRejectedValueOnce(new TypeError("Network connection lost."));
    const { env } = makeEnv();
    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });
    expect((await problemOf(response)).code).toBe("target_refused");
  });

  test("gives up when the first byte is late", async () => {
    vi.useFakeTimers();
    try {
      targetFetch.mockImplementationOnce(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const { env } = makeEnv();
      const pending = sendTryRequest({ env, body: bodyOf(goodRequest), context });
      // The check of the target ID uses real time, so the send starts later.
      await vi.waitFor(() => expect(targetFetch).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await problemOf(await pending)).code).toBe("target_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("limitBody", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  test("passes a body under the limit", async () => {
    const out = limitBody(streamOf(["ab", "cd"]), { maxBytes: 10, totalMs: 1_000 });
    expect(await new Response(out).text()).toBe("abcd");
  });

  test("ends the stream exactly at the byte limit", async () => {
    const out = limitBody(streamOf(["abcd", "efgh"]), { maxBytes: 6, totalMs: 1_000 });
    expect(await new Response(out).text()).toBe("abcdef");
  });

  test("ends the stream at the time limit and keeps what arrived", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
      },
    });
    const out = limitBody(source, { maxBytes: 100, totalMs: 20 });
    expect(await new Response(out).text()).toBe("first");
  });

  test("cancels the target when the reader goes away", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const out = limitBody(source, { maxBytes: 100, totalMs: 1_000 });
    await out.cancel("reader left");
    expect(cancel).toHaveBeenCalled();
  });
});

describe("readTryConfig", () => {
  test("names the mode and the host", async () => {
    const { env } = makeEnv();
    await expect(readTryConfig(env, context)).resolves.toMatchObject({
      mode: "proxy",
      targetHost: "api.acme.com",
      targetBaseUrl: "https://api.acme.com/v1",
    });
  });

  test("falls back to the browser when the kill switch is on", async () => {
    const { env } = makeEnv({ DOXA_PROD_TRY_PROXY_MODE: "off" });
    await expect(readTryConfig(env, context)).resolves.toEqual({
      mode: "browser",
      reason: "proxy_off",
    });
  });

  test.each(["https://localhost", "http://api.acme.com"])(
    "falls back to the browser for %s",
    async (baseUrl) => {
      const { env } = makeEnv();
      await expect(readTryConfig(env, { ...context, baseUrl })).resolves.toEqual({
        mode: "browser",
        reason: "target_not_allowed",
      });
    },
  );

  test("falls back to the browser for a blocked host", async () => {
    const { env } = makeEnv({ DOXA_TRY_BLOCKED_HOSTS: "acme.com" });
    await expect(readTryConfig(env, context)).resolves.toEqual({
      mode: "browser",
      reason: "target_not_allowed",
    });
  });
});

// SECURITY REGRESSION GUARDRAIL: a panel that loaded before a settings change
// must not send the reader's key to the new target.
describe("a target that changed after the panel loaded", () => {
  test("refuses the send and does not contact any target", async () => {
    const { env } = makeEnv();
    const moved = { ...context, baseUrl: "https://new-target.example.net/v2" };

    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context: moved });

    expect(response.status).toBe(409);
    expect((await problemOf(response)).code).toBe("target_changed");
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("refuses a change of the base path on the same host", async () => {
    const { env } = makeEnv();
    const moved = { ...context, baseUrl: "https://api.acme.com/v2" };

    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context: moved });

    expect((await problemOf(response)).code).toBe("target_changed");
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("refuses a request with no target ID", async () => {
    const { env } = makeEnv();
    const { targetId: _targetId, ...request } = goodRequest;

    const response = await sendTryRequest({ env, body: bodyOf(request), context });

    expect((await problemOf(response)).code).toBe("invalid_request");
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("gives the config a target ID that holds no address", async () => {
    expect(acmeConfig.targetId).toMatch(/^[0-9a-f]{32}$/);
  });
});

// SECURITY REGRESSION GUARDRAIL: the target controls the body, so reading it
// must stay inside the limits.
describe("classifyCloudflareFailure", () => {
  const plainText = { "content-type": "text/plain" };

  /** A body that gives `size` bytes per read, without end. Counts what it gave. */
  function endlessBody(size: number) {
    const counter = { bytes: 0 };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          counter.bytes += size;
          controller.enqueue(new Uint8Array(size).fill(97));
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, counter };
  }

  test("reads only the start of an endless error body", async () => {
    const { stream, counter } = endlessBody(1024);
    const { failure } = await classifyCloudflareFailure(
      new Response(stream, { status: 403, headers: plainText }),
    );

    expect(failure).toBeNull();
    expect(counter.bytes).toBeLessThanOrEqual(1024);
  });

  test("does not wait for a body that stays open", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("error code: 1016"));
      },
    });
    const { failure } = await classifyCloudflareFailure(
      new Response(stream, { status: 530, headers: plainText }),
      10,
    );

    expect(failure).toBeNull();
  });

  test("gives the whole body on, when the body waited during the check", async () => {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(encoder.encode("first "));
      },
    });
    const { body } = await classifyCloudflareFailure(
      new Response(stream, { status: 403, headers: plainText }),
      10,
    );
    controllerRef.enqueue(encoder.encode("second"));
    controllerRef.close();

    expect(await new Response(body).text()).toBe("first second");
  });

  test("does not take error text with more content after it as an error", async () => {
    const text = `error code: 1016\n${" ".repeat(64)}real API content`;
    const { failure, body } = await classifyCloudflareFailure(
      new Response(text, { status: 530, headers: plainText }),
    );

    expect(failure).toBeNull();
    expect(await new Response(body).text()).toBe(text);
  });

  test("does not read the body of other answers", async () => {
    const { stream, counter } = endlessBody(1024);
    const answer = new Response(stream, { status: 200, headers: plainText });
    const { failure, body } = await classifyCloudflareFailure(answer);

    expect(failure).toBeNull();
    expect(body).toBe(answer.body);
    expect(counter.bytes).toBe(0);
  });
});

describe("the time limit of a send", () => {
  test("counts the wait for the answer", async () => {
    targetFetch.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const clock = vi.fn(() => 60_000);
    clock.mockReturnValueOnce(0).mockReturnValueOnce(0);
    const { env } = makeEnv();

    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context, now: clock });

    expect(await response.text()).toBe("");
  });
});

// SECURITY REGRESSION GUARDRAIL: target limits are shared between sites, so a
// request that a narrower limit refuses must not use them.
describe("the order of the limits", () => {
  function makeLimitEnv() {
    const taken: string[] = [];
    const refuse = { site: false, target: false };
    const { env } = makeEnv({
      TRY_BUDGET: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          take: vi.fn(async () => {
            taken.push(name);
            return name.startsWith("site:") ? !refuse.site : !refuse.target;
          }),
        }),
      },
    } as unknown as Partial<TryProxyEnv>);
    return { env, taken, refuse };
  }
  const limited = () => vi.fn(async () => ({ success: false }));

  test("a client refusal uses no other limit", async () => {
    const { env, taken } = makeLimitEnv();
    env.TRY_CLIENT.limit = limited();

    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect((await problemOf(response)).code).toBe("rate_limited");
    expect(env.TRY_SITE.limit).not.toHaveBeenCalled();
    expect(env.TRY_TARGET.limit).not.toHaveBeenCalled();
    expect(taken).toEqual([]);
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("a site refusal does not use the target limit", async () => {
    const { env, taken } = makeLimitEnv();
    env.TRY_SITE.limit = limited();

    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect(env.TRY_TARGET.limit).not.toHaveBeenCalled();
    expect(taken).toEqual([]);
  });

  test("a full site budget does not use the target budget", async () => {
    const { env, taken, refuse } = makeLimitEnv();
    refuse.site = true;

    const response = await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect((await problemOf(response)).code).toBe("rate_limited");
    expect(taken).toEqual(["site:site-1"]);
    expect(env.TRY_TARGET.limit).not.toHaveBeenCalled();
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("a target minute refusal does not use the target budget", async () => {
    const { env, taken } = makeLimitEnv();
    env.TRY_TARGET.limit = limited();

    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect(taken).toEqual(["site:site-1"]);
    expect(targetFetch).not.toHaveBeenCalled();
  });

  test("a good send uses both budgets", async () => {
    const { env, taken } = makeLimitEnv();

    await sendTryRequest({ env, body: bodyOf(goodRequest), context });

    expect(taken).toEqual(["site:site-1", "target:api.acme.com"]);
    expect(targetFetch).toHaveBeenCalledTimes(1);
  });
});

/** The rule keeps these out of the code, so a change has to edit this test. */
test("the Worker has no secrets, no private route and no logs", async () => {
  const { readFileSync } = await import("node:fs");
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"),
  ) as Record<string, unknown> & { observability: Record<string, unknown>; compatibility_flags: string[] };

  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.logpush).toBe(false);
  expect(config.observability.enabled).toBe(false);
  expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  expect(config.compatibility_flags).not.toContain("nodejs_compat");
  for (const binding of [
    "routes",
    "route",
    "vpc_services",
    "hyperdrive",
    "r2_buckets",
    "kv_namespaces",
    "d1_databases",
    "services",
    "queues",
    "secrets_store_secrets",
  ]) {
    expect(config[binding], binding).toBeUndefined();
  }
});

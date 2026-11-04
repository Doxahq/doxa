import {
  DOCS_TRY_RESULT_HEADER,
  encodeDocsTryResult,
  type DocsTryRequest,
} from "@doxahq/contracts/docs-try";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  loadTryConfig,
  sendFromBrowser,
  sendThroughDoxa,
  type PlaygroundAnswer,
} from "@/src/lib/try-client";

const request: DocsTryRequest = {
  v: 1,
  targetId: "target-1",
  method: "GET",
  path: "/x",
  query: [],
  headers: [["x-api-key", "secret"]],
  cookies: [],
};

function options() {
  return { signal: new AbortController().signal };
}

function proxyAnswer(body: BodyInit | null, status: number, headers: [string, string][]) {
  return new Response(body, {
    headers: {
      [DOCS_TRY_RESULT_HEADER]: encodeDocsTryResult({
        status,
        statusText: "",
        elapsedMs: 12,
        headers,
        headersTruncated: false,
      }),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a target that changed after the panel loaded", () => {
  test("is a refusal, so the panel can clear the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "target_changed", title: "This site changed its API address." },
          { status: 409, headers: { "content-type": "application/problem+json" } }
        )
      )
    );

    await expect(sendThroughDoxa(request, options())).resolves.toMatchObject({
      kind: "refused",
      code: "target_changed",
    });
  });
});

describe("loadTryConfig", () => {
  test("reads the mode from the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ mode: "proxy", targetHost: "api.acme.com", limits: {} })
    ));
    await expect(loadTryConfig()).resolves.toMatchObject({ mode: "proxy" });
  });

  test.each([
    ["a 404, as in local dev", () => new Response("nope", { status: 404 })],
    ["HTML from a catch-all route", () => new Response("<html>", { status: 200 })],
    ["an unknown mode", () => Response.json({ mode: "other" })],
  ])("falls back to the browser on %s", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    await expect(loadTryConfig()).resolves.toEqual({
      mode: "browser",
      reason: "proxy_off",
    });
  });

  test("falls back to the browser when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("offline");
    }));
    await expect(loadTryConfig()).resolves.toMatchObject({ mode: "browser" });
  });
});

describe("sendThroughDoxa", () => {
  test("posts the request to its own origin, with no cookies", async () => {
    const fetchSpy = vi.fn(async () => proxyAnswer("{}", 200, []));
    vi.stubGlobal("fetch", fetchSpy);
    await sendThroughDoxa(request, options());

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/__doxa/try");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/vnd.doxa.try+json"
    );
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  test("reads the target's answer from the result header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer('{"ok":false}', 401, [["content-type", "application/json"]])
    ));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;

    expect(outcome.kind).toBe("answer");
    expect(outcome.via).toBe("proxy");
    expect(outcome.status).toBe(401);
    expect(outcome.text).toBe('{"ok":false}');
    expect(outcome.contentType).toBe("application/json");
    expect(outcome.bytes).toBe(12);
  });

  test.each([
    ["image/png"],
    ["application/octet-stream"],
    ["application/pdf"],
  ])("treats %s as binary", async (contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer(new Uint8Array([1, 2, 3]), 200, [["content-type", contentType]])
    ));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;
    expect(outcome.text).toBeNull();
    expect(outcome.bytes).toBe(3);
    expect(outcome.raw).toEqual(new Uint8Array([1, 2, 3]));
  });

  test.each([
    ["text/html"],
    ["image/svg+xml"],
    ["application/problem+json"],
    ["application/vnd.api+json"],
    ["text/event-stream"],
  ])("shows %s as text only", async (contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer("<svg onload=alert(1)>", 200, [["content-type", contentType]])
    ));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;
    expect(outcome.text).toBe("<svg onload=alert(1)>");
  });

  test("marks an unknown type from its bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => proxyAnswer(new Uint8Array([0xff, 0xfe]), 200, [])));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;
    expect(outcome.text).toBeNull();
  });

  test("marks a body at the size limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer(new Uint8Array(10 * 1024 * 1024), 200, [["content-type", "image/png"]])
    ));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;
    expect(outcome.stoppedBy).toBe("size");
  });

  test("keeps only the first part of a long text for display", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer("x".repeat(300 * 1024), 200, [["content-type", "text/plain"]])
    ));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;
    expect(outcome.textCut).toBe(true);
    expect(outcome.text?.length).toBe(256 * 1024);
    expect(outcome.bytes).toBe(300 * 1024);
  });

  function problem(status: number, code: string, title: string, retryAfter?: number) {
    return new Response(JSON.stringify({ code, title, ...(retryAfter ? { retryAfter } : {}) }), {
      status,
      headers: { "content-type": "application/problem+json" },
    });
  }

  test("reports a refusal as Doxa's, not as the API's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => problem(429, "rate_limited", "Too many.", 30)));
    await expect(sendThroughDoxa(request, options())).resolves.toEqual({
      kind: "refused",
      code: "rate_limited",
      title: "Too many.",
      retryAfter: 30,
    });
  });

  test.each([
    ["target_dns", false],
    ["target_tls", false],
    ["target_refused", null],
    ["target_timeout", true],
  ])("reports %s as a failed connection, and if the key left", async (code, keyLeft) => {
    vi.stubGlobal("fetch", vi.fn(async () => problem(502, code, "No.")));
    await expect(sendThroughDoxa(request, options())).resolves.toMatchObject({
      kind: "failed",
      code,
      keyLeftDoxa: keyLeft,
    });
  });

  test("reads the plain 429 of the gateway limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("Too many requests.", { status: 429, headers: { "retry-after": "60" } })
    ));
    await expect(sendThroughDoxa(request, options())).resolves.toMatchObject({
      kind: "refused",
      code: "rate_limited",
      retryAfter: 60,
    });
  });

  test("never reads a page with no result header as an answer of the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
    ));
    await expect(sendThroughDoxa(request, options())).resolves.toMatchObject({
      kind: "failed",
      title: "Doxa could not send this request.",
    });
  });

  test("says so when a reader cancels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    }));
    await expect(sendThroughDoxa(request, options())).resolves.toMatchObject({
      kind: "failed",
      title: "You canceled this request.",
    });
  });

  test("keeps what arrived when a reader cancels a stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n"));
        controller.error(new DOMException("Aborted", "AbortError"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer(stream, 200, [["content-type", "text/event-stream"]])
    ));
    const outcome = (await sendThroughDoxa(request, options())) as PlaygroundAnswer;
    expect(outcome.stoppedBy).toBe("reader");
  });

  test("reports progress while a body arrives", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      proxyAnswer(stream, 200, [["content-type", "text/plain"]])
    ));
    const onProgress = vi.fn();
    await sendThroughDoxa(request, { ...options(), onProgress });
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({ streaming: true, text: "first" });
  });
});

describe("sendFromBrowser", () => {
  const browserRequest = { url: "https://api.example.com/x", init: { method: "GET" } };

  test("names CORS as a possible cause, without claiming it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const outcome = await sendFromBrowser(browserRequest, options());
    expect(outcome).toMatchObject({ kind: "failed", keyLeftDoxa: null });
    if (outcome.kind !== "failed") throw new Error("expected a failure");
    expect(outcome.detail).toContain("may not allow");
  });

  test("returns the API's answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("{}", { status: 201, headers: { "content-type": "application/json" } })
    ));
    await expect(sendFromBrowser(browserRequest, options())).resolves.toMatchObject({
      kind: "answer",
      via: "browser",
      status: 201,
    });
  });
});

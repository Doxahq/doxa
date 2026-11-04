import { afterEach, describe, expect, test, vi } from "vitest";

import { runEdgeGateway } from "../src/edge-gateway";
import {
  createHttpsRedirect,
  HTTPS_REDIRECT_LOG_SAMPLE_RATE,
  isCertificateValidationPath,
  parseHttpsRedirectMode,
} from "../src/https-policy";
import { stripInboundDoxaHeaders } from "../src/inbound-headers";
import { withDocsStrictTransportSecurity } from "../src/security-headers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inbound header strip", () => {
  test("removes every x-doxa-* header and keeps the others", () => {
    const request = new Request("https://docs.example.com/guide", {
      headers: {
        accept: "text/html",
        "X-Doxa-Cache-Probe": "1",
        "x-doxa-internal-render-id": "a".repeat(64),
        "x-doxa-host": "other.example.com",
        "x-doxa-project-id": "project-2",
        "x-doxanot-internal": "kept",
      },
    });

    const stripped = stripInboundDoxaHeaders(request);

    expect([...stripped.headers.keys()].sort()).toEqual([
      "accept",
      "x-doxanot-internal",
    ]);
    expect(stripped.url).toBe(request.url);
    expect(stripped.method).toBe("GET");
  });

  test("returns the same request when it has no internal header", () => {
    const request = new Request("https://docs.example.com/guide", {
      headers: { accept: "text/html" },
    });

    expect(stripInboundDoxaHeaders(request)).toBe(request);
  });

  test("keeps the method and body of a stripped request", async () => {
    const request = new Request("https://docs.example.com/api/search", {
      method: "POST",
      headers: { "x-doxa-host": "evil.example.com" },
      body: "query",
    });

    const stripped = stripInboundDoxaHeaders(request);

    expect(stripped.method).toBe("POST");
    expect(await stripped.text()).toBe("query");
  });
});

describe("HTTPS redirect mode", () => {
  test("is off unless the value is exactly on", () => {
    const warn = vi.fn();
    expect(parseHttpsRedirectMode(undefined, warn)).toBe("off");
    expect(parseHttpsRedirectMode("off", warn)).toBe("off");
    expect(parseHttpsRedirectMode("on", warn)).toBe("on");
    expect(warn).not.toHaveBeenCalled();
  });

  test("an invalid value warns and fails closed", () => {
    const warn = vi.fn();
    expect(parseHttpsRedirectMode("ON", warn)).toBe("off");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DOXA_PROD_HTTPS_REDIRECT_MODE"),
    );
  });
});

describe("HTTPS redirect", () => {
  const never = () => 1;

  test.each([
    ["GET", 301],
    ["HEAD", 301],
    ["POST", 308],
    ["PUT", 308],
    ["DELETE", 308],
  ])("redirects %s with %i and keeps path and query", (method, status) => {
    const response = createHttpsRedirect(
      new Request("http://docs.example.com/guide/intro?tab=a&b=1", {
        method,
      }),
      { random: never },
    );

    expect(response?.status).toBe(status);
    expect(response?.headers.get("location")).toBe(
      "https://docs.example.com/guide/intro?tab=a&b=1",
    );
    expect(response?.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    expect(response?.headers.has("strict-transport-security")).toBe(false);
  });

  test("redirects to the request host only, without the HTTP port", () => {
    const response = createHttpsRedirect(
      new Request("http://docs.example.com:8080/a//b?next=https://evil.example"),
      { random: never },
    );

    const location = new URL(response?.headers.get("location") ?? "");
    expect(location.origin).toBe("https://docs.example.com");
    expect(location.pathname).toBe("/a//b");
    expect(location.search).toBe("?next=https://evil.example");
  });

  test("leaves an HTTPS request alone", () => {
    expect(
      createHttpsRedirect(new Request("https://docs.example.com/guide")),
    ).toBeNull();
  });

  test.each([
    "/.well-known/acme-challenge/token-1",
    "/.well-known/cf-custom-hostname-challenge/abc",
  ])("never redirects the certificate validation path %s", (path) => {
    expect(isCertificateValidationPath(path)).toBe(true);
    expect(
      createHttpsRedirect(new Request(`http://docs.example.com${path}`)),
    ).toBeNull();
  });

  test.each([
    "/.well-known/acme-challenge",
    "/.well-known/doxa-health",
    "/guide/.well-known/acme-challenge/x",
  ])("redirects the other path %s", (path) => {
    expect(isCertificateValidationPath(path)).toBe(false);
    expect(
      createHttpsRedirect(new Request(`http://docs.example.com${path}`), {
        random: never,
      })?.status,
    ).toBe(301);
  });

  test("logs a sample of redirects, without the path", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const request = new Request("http://docs.example.com/secret-path?q=1");

    createHttpsRedirect(request, { random: () => 0.5 });
    expect(info).not.toHaveBeenCalled();

    createHttpsRedirect(request, {
      random: () => HTTPS_REDIRECT_LOG_SAMPLE_RATE / 2,
    });
    expect(info).toHaveBeenCalledOnce();
    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "docs_https_redirect",
      hostname: "docs.example.com",
      method: "GET",
      status: 301,
      sampleRate: HTTPS_REDIRECT_LOG_SAMPLE_RATE,
    });
    expect(line).not.toContain("secret-path");
  });
});

describe("HSTS", () => {
  test("adds one day of HSTS to an HTTPS response, on a copy", async () => {
    const original = new Response("page", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
    const response = withDocsStrictTransportSecurity(
      original,
      new Request("https://docs.example.com/guide"),
    );

    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=86400",
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("page");
    expect(original.headers.has("strict-transport-security")).toBe(false);
  });

  test("leaves a plain-HTTP response unchanged", () => {
    const original = new Response("page");
    expect(
      withDocsStrictTransportSecurity(
        original,
        new Request("http://docs.example.com/.well-known/acme-challenge/x"),
      ),
    ).toBe(original);
  });
});

describe("runEdgeGateway", () => {
  function handler() {
    return vi.fn(async (_request: Request) => new Response("routed"));
  }

  test("routes only the stripped request", async () => {
    const handle = handler();
    await runEdgeGateway(
      new Request("https://docs.example.com/guide", {
        headers: { "x-doxa-cache-probe": "1", accept: "text/html" },
      }),
      {},
      handle,
    );

    const routed = handle.mock.calls[0]?.[0];
    expect(routed?.headers.has("x-doxa-cache-probe")).toBe(false);
    expect(routed?.headers.get("accept")).toBe("text/html");
  });

  test("mode off neither redirects nor adds HSTS", async () => {
    const handle = handler();
    const plain = await runEdgeGateway(
      new Request("http://docs.example.com/guide"),
      { DOXA_PROD_HTTPS_REDIRECT_MODE: "off" },
      handle,
    );
    const secure = await runEdgeGateway(
      new Request("https://docs.example.com/guide"),
      {},
      handle,
    );

    expect(plain.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(secure.headers.has("strict-transport-security")).toBe(false);
  });

  test("mode on redirects plain HTTP before any routing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const handle = handler();
    const response = await runEdgeGateway(
      new Request("http://docs.example.com/guide"),
      { DOXA_PROD_HTTPS_REDIRECT_MODE: "on" },
      handle,
    );

    expect(response.status).toBe(301);
    expect(handle).not.toHaveBeenCalled();
  });

  test("mode on routes a certificate validation path over HTTP without HSTS", async () => {
    const handle = handler();
    const response = await runEdgeGateway(
      new Request("http://docs.example.com/.well-known/acme-challenge/token"),
      { DOXA_PROD_HTTPS_REDIRECT_MODE: "on" },
      handle,
    );

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(response.headers.has("strict-transport-security")).toBe(false);
  });

  test("mode on adds HSTS to every HTTPS response", async () => {
    const response = await runEdgeGateway(
      new Request("https://docs.example.com/missing"),
      { DOXA_PROD_HTTPS_REDIRECT_MODE: "on" },
      async () => new Response("not found", { status: 404 }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=86400",
    );
  });
});

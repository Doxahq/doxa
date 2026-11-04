import { isDocsTryTargetOfPage, parseDocsTryTarget } from "@doxahq/contracts/docs-try";
import { describe, expect, test } from "vitest";

import { buildTargetHeaders, buildTargetUrl, TRY_USER_AGENT } from "../src/target-request";

/**
 * SECURITY REGRESSION GUARDRAIL: the owner proves no control of the target, so
 * these rules are the only checks on where a request can go.
 */
// SECURITY REGRESSION GUARDRAIL: a key must not follow a target that the reader
// never saw. A page can stay open while the owner changes the target.
describe("isDocsTryTargetOfPage", () => {
  test.each([
    "https://api.acme.com/v1",
    "https://api.acme.com/v1/",
    "https://API.acme.com/v1",
    "https://api.acme.com./v1",
  ])("accepts %s as the same target", (pageBaseUrl) => {
    expect(isDocsTryTargetOfPage("https://api.acme.com/v1", pageBaseUrl)).toBe(true);
  });

  test.each([
    "https://new-target.example.net/v1",
    "https://api.acme.com/v2",
    "https://api.acme.com",
    "http://api.acme.com/v1",
    "/v1",
    "not a url",
  ])("refuses %s as another target", (pageBaseUrl) => {
    expect(isDocsTryTargetOfPage("https://api.acme.com/v1", pageBaseUrl)).toBe(false);
  });
});

describe("parseDocsTryTarget", () => {
  const zones = ["doxa.so", "doxa.page"];

  test.each([
    ["https://api.acme.com", "api.acme.com", ""],
    ["https://api.acme.com/", "api.acme.com", ""],
    ["https://api.acme.com/v1/", "api.acme.com", "/v1"],
    ["https://API.Acme.COM./v1", "api.acme.com", "/v1"],
    ["https://api.acme.com:443/v1", "api.acme.com", "/v1"],
    ["https://1.2.3.4.nip.io/", "1.2.3.4.nip.io", ""],
  ])("accepts %s", (baseUrl, host, basePath) => {
    expect(parseDocsTryTarget(baseUrl, zones)).toEqual({
      ok: true,
      origin: `https://${host}`,
      host,
      basePath,
    });
  });

  test.each([
    ["/api/echo", "relative"],
    ["not a url", "invalid"],
    ["http://api.acme.com", "not_https"],
    ["ftp://api.acme.com", "not_https"],
    ["https://user:pass@api.acme.com", "credentials"],
    ["https://user@api.acme.com", "credentials"],
    ["https://api.acme.com:8443", "port"],
    ["https://api.acme.com?key=1", "query"],
    ["https://api.acme.com#x", "query"],
    ["https://localhost", "not_a_dns_name"],
    ["https://intranet", "not_a_dns_name"],
    ["https://127.0.0.1", "ip_literal"],
    ["https://2130706433", "ip_literal"],
    ["https://0x7f.0.0.1", "ip_literal"],
    ["https://0177.0.0.1", "ip_literal"],
    ["https://127.1", "ip_literal"],
    ["https://169.254.169.254", "ip_literal"],
    ["https://169.254.170.2", "ip_literal"],
    ["https://[::1]", "ip_literal"],
    ["https://[::ffff:7f00:1]", "ip_literal"],
    ["https://1.1.1.1", "ip_literal"],
    ["https://api.localhost", "local_name"],
    ["https://db.internal", "local_name"],
    ["https://printer.local", "local_name"],
    ["https://x.onion", "local_name"],
    ["https://doxa.so", "reserved_zone"],
    ["https://api.doxa.so", "reserved_zone"],
    ["https://acme.doxa.page", "reserved_zone"],
    ["https://ACME.DOXA.PAGE./v1", "reserved_zone"],
  ])("refuses %s (%s)", (baseUrl, reason) => {
    expect(parseDocsTryTarget(baseUrl, zones)).toEqual({ ok: false, reason });
  });

  test("does not treat a look-alike name as a reserved zone", () => {
    expect(parseDocsTryTarget("https://notdoxa.so", zones).ok).toBe(true);
    expect(parseDocsTryTarget("https://doxa.so.evil.example", zones).ok).toBe(true);
  });
});

describe("buildTargetUrl", () => {
  const target = { origin: "https://api.acme.com", basePath: "/v1" };
  const build = (path: string, query: [string, string][] = []) =>
    buildTargetUrl(target, { path, query })?.toString() ?? null;

  test("keeps a good path under the base path", () => {
    expect(build("/notes/abc")).toBe("https://api.acme.com/v1/notes/abc");
    expect(build("/")).toBe("https://api.acme.com/v1/");
    expect(build("/files/a%2Fb")).toBe("https://api.acme.com/v1/files/a%2Fb");
  });

  test("adds the query as encoded pairs, with repeats", () => {
    expect(
      build("/notes", [
        ["tag", "a b"],
        ["tag", "c&d=e"],
      ]),
    ).toBe("https://api.acme.com/v1/notes?tag=a+b&tag=c%26d%3De");
  });

  test.each([
    ["no leading slash", "notes"],
    ["protocol-relative", "//evil.example/x"],
    ["double slash inside", "/a//b"],
    ["backslash", "/\\evil.example"],
    ["backslash inside", "/a\\b"],
    ["query", "/a?b=c"],
    ["fragment", "/a#b"],
    ["tab", "/a\tb"],
    ["newline", "/a\nb"],
    ["null byte", "/a\u0000b"],
    ["dot-dot", "/../admin"],
    ["dot-dot inside", "/a/../../admin"],
    ["single dot", "/./a"],
    ["encoded dot-dot", "/%2e%2e/admin"],
    ["upper case encoded dot-dot", "/%2E%2E/admin"],
    ["half encoded dot-dot", "/.%2e/admin"],
    ["encoded slash after dots", "/..%2fadmin"],
    ["encoded backslash after dots", "/..%5cadmin"],
    ["double encoded dots", "/%252e%252e/admin"],
    ["double encoded slash", "/..%252fadmin"],
  ])("refuses %s", (_name, path) => {
    expect(build(path)).toBeNull();
  });

  test("never leaves the origin, whatever the at sign says", () => {
    expect(build("/@evil.example/x")).toBe("https://api.acme.com/v1/@evil.example/x");
  });
});

describe("buildTargetHeaders", () => {
  const build = (headers: [string, string][], cookies: [string, string][] = []) =>
    buildTargetHeaders({ headers, cookies }, "site-1");

  test("starts empty, then adds only the reader's values and the Doxa identity", () => {
    const result = build([["x-api-key", "secret"]]);
    if (!result.ok) throw new Error("refused");
    expect([...result.headers].sort()).toEqual([
      ["user-agent", TRY_USER_AGENT],
      ["x-api-key", "secret"],
      ["x-doxa-try-site", "site-1"],
    ]);
  });

  test("joins typed cookies into one header", () => {
    const result = build([], [["session", "abc"], ["theme", "dark"]]);
    if (!result.ok) throw new Error("refused");
    expect(result.headers.get("cookie")).toBe("session=abc; theme=dark");
  });

  test.each([
    "Host",
    "Connection",
    "Content-Length",
    "Transfer-Encoding",
    "Upgrade",
    "TE",
    "Origin",
    "Referer",
    "User-Agent",
    "Accept-Encoding",
    "Forwarded",
    "Via",
    "X-Real-IP",
    "True-Client-IP",
    "CF-Connecting-IP",
    "CF-Worker",
    "X-Forwarded-For",
    "X-Forwarded-Host",
    "Proxy-Authorization",
    "Sec-Fetch-Site",
    "X-Doxa-Try-Site",
    "bad name",
    "API key",
    "",
  ])("refuses the header name %j", (name) => {
    expect(build([[name, "value"]])).toEqual({ ok: false, name });
  });

  test.each([["a\r\nInjected: 1"], ["a\nb"], ["a\u0000b"]])(
    "refuses the header value %j",
    (value) => {
      expect(build([["x-test", value]]).ok).toBe(false);
    },
  );

  test.each([
    ["bad name", "v"],
    ["a", "b;c=d"],
    ["a", "b\r\nc"],
  ])("refuses the cookie %j=%j", (name, value) => {
    expect(build([], [[name, value]])).toEqual({ ok: false, name: "cookie" });
  });

  test("refuses headers over the total size", () => {
    const big = "x".repeat(9_000);
    expect(build([["a", big], ["b", big]])).toEqual({ ok: false, name: "total size" });
  });
});

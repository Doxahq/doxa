import { describe, expect, test } from "vitest";
import { corsPreflight, json, withCors } from "../../src/http/response";

describe("withCors", () => {
  test("allows matching origins and appends Vary", () => {
    const response = withCors(
      json({ ok: true }, { headers: { vary: "Accept-Encoding" } }),
      new Request("http://localhost", { headers: { origin: "https://dev.doxa.so" } }),
      "https://dev.doxa.so",
    );

    expect(response.headers.get("access-control-allow-origin")).toBe("https://dev.doxa.so");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
  });

  test("does not allow non-matching configured origins", () => {
    const response = withCors(
      json({ ok: true }),
      new Request("http://localhost", { headers: { origin: "https://evil.test" } }),
      "https://dev.doxa.so",
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("corsPreflight", () => {
  test("returns expected preflight headers for an allowed origin", () => {
    const response = corsPreflight(
      new Request("http://localhost", {
        method: "OPTIONS",
        headers: { origin: "https://dev.doxa.so" },
      }),
      "https://dev.doxa.so",
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://dev.doxa.so");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

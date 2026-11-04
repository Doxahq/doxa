import { describe, expect, test } from "vitest";
import { limitRequestBody, RequestBodyTooLarge } from "../../src/http/bounded-body";

/** SECURITY REGRESSION GUARDRAIL (SEC-003): Better Auth and the OAuth provider get bounded bodies. */
describe("limitRequestBody", () => {
  function stream(bytes: number): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes).fill(97));
        controller.close();
      },
    });
  }

  test("throws at once for a declared length above the limit", () => {
    const request = new Request("http://localhost/api/auth/sign-in", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2048" },
    });

    expect(() => limitRequestBody(request, 1024)).toThrow(RequestBodyTooLarge);
  });

  test("keeps a request with a declared length inside the limit", () => {
    const request = new Request("http://localhost/api/auth/sign-in", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    });

    expect(limitRequestBody(request, 1024)).toBe(request);
  });

  test("errors a chunked body when it passes the limit", async () => {
    const request = new Request("http://localhost/token", {
      method: "POST",
      body: stream(2048),
      duplex: "half",
    } as RequestInit);

    await expect(limitRequestBody(request, 1024).text()).rejects.toBeInstanceOf(RequestBodyTooLarge);
  });

  test("passes a chunked body inside the limit", async () => {
    const request = new Request("http://localhost/token", {
      method: "POST",
      body: stream(10),
      duplex: "half",
    } as RequestInit);

    await expect(limitRequestBody(request, 1024).text()).resolves.toBe("a".repeat(10));
  });
});

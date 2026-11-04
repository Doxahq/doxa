import { describe, expect, test } from "vitest";

import { createEchoResponse } from "@/src/routes/api.echo.$";

describe("API playground echo", () => {
  test("echoes request data without exposing the authorization credential", async () => {
    const request = new Request(
      "https://docs.example.com/api/echo/v1/messages?include=sender&include=metadata&limit=10",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer private-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "Hello from the playground" }),
      }
    );

    const response = await createEchoResponse(request, "v1/messages");
    const payload: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({
      method: "POST",
      path: "/v1/messages",
      query: {
        include: ["sender", "metadata"],
        limit: "10",
      },
      body: { body: "Hello from the playground" },
      authorization: "[REDACTED]",
    });
    expect(JSON.stringify(payload)).not.toContain("private-token");
  });

  test("returns empty request fields when the request has no input", async () => {
    const request = new Request("https://docs.example.com/api/echo", {
      method: "GET",
    });

    const response = await createEchoResponse(request, undefined);

    await expect(response.json()).resolves.toEqual({
      method: "GET",
      path: "/",
      query: {},
      body: null,
      authorization: null,
    });
  });
});

// SECURITY REGRESSION GUARDRAIL (SEC-007): the echo route reads a bounded body.
describe("echo body limit", () => {
  test("answers 413 for a declared body above 64 KB", async () => {
    const response = await createEchoResponse(
      new Request("https://acme.doxa.page/api/echo/v1/messages", {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(64 * 1024 + 1) },
      }),
      "v1/messages",
    );

    expect(response.status).toBe(413);
  });

  test("answers 413 for a streamed body above 64 KB", async () => {
    const response = await createEchoResponse(
      new Request("https://acme.doxa.page/api/echo/v1/messages", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(97));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
      "v1/messages",
    );

    expect(response.status).toBe(413);
  });
});

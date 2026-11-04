import { describe, expect, test } from "vitest";
import { z } from "zod";
import { JSON_BODY_MAX_BYTES, isResponse, parseJson, readValidBody } from "../../src/http/body";
import { RequestBodyTooLarge } from "../../src/http/bounded-body";

describe("parseJson", () => {
  test("returns parsed JSON bodies", async () => {
    const parsed = await parseJson<{ ok: boolean }>(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }),
    );

    expect(parsed).toEqual({ ok: true });
  });

  test("returns a 400 response for invalid JSON", async () => {
    const parsed = await parseJson(
      new Request("http://localhost", {
        method: "POST",
        body: "{",
      }),
    );

    expect(isResponse(parsed)).toBe(true);
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
  });
});

describe("readValidBody", () => {
  const schema = z.object({ note: z.string().optional() }).strict();
  const post = (body: string) => new Request("http://localhost", { method: "POST", body });

  test("returns the parsed body when it matches", async () => {
    await expect(readValidBody(post('{"note":"hi"}'), schema)).resolves.toEqual({ note: "hi" });
  });

  test("returns null for invalid JSON or a body that does not match", async () => {
    await expect(readValidBody(post("{"), schema)).resolves.toBeNull();
    await expect(readValidBody(post('{"other":1}'), schema)).resolves.toBeNull();
  });

  test("reads an empty body as {} only when the body is optional", async () => {
    await expect(readValidBody(post(""), schema)).resolves.toBeNull();
    await expect(readValidBody(post("  "), schema, { optional: true })).resolves.toEqual({});
  });
});

/** SECURITY REGRESSION GUARDRAIL (SEC-003): JSON bodies are bounded before they are read. */
describe("JSON body limit", () => {
  function chunkedBody(bytes: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const size = Math.min(1024 * 1024, bytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(32));
      },
    });
  }

  test("parseJson answers 413 for a declared length above the limit", async () => {
    const parsed = await parseJson(
      new Request("http://localhost", {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(JSON_BODY_MAX_BYTES + 1) },
      }),
    );

    expect((parsed as Response).status).toBe(413);
  });

  test("parseJson answers 413 for a chunked body that passes the limit", async () => {
    const parsed = await parseJson(
      new Request("http://localhost", {
        method: "POST",
        body: chunkedBody(JSON_BODY_MAX_BYTES + 1),
        duplex: "half",
      } as RequestInit),
    );

    expect((parsed as Response).status).toBe(413);
  });

  test("readValidBody throws RequestBodyTooLarge above the limit", async () => {
    await expect(
      readValidBody(
        new Request("http://localhost", {
          method: "POST",
          body: chunkedBody(JSON_BODY_MAX_BYTES + 1),
          duplex: "half",
        } as RequestInit),
        z.object({}),
      ),
    ).rejects.toBeInstanceOf(RequestBodyTooLarge);
  });
});

import { describe, expect, test } from "vitest";

import {
  readBoundedBody,
  readBoundedBodyWithin,
  RequestBodyTimeout,
  RequestBodyTooLarge,
} from "../../src/http/bounded-body";

/** A body that sends one chunk, then never ends: a slow-loris client. */
function stalledRequest(): { request: Request; cancelled: () => boolean } {
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      }
      // Never closes.
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://test/", { method: "PUT", body, duplex: "half" } as RequestInit);
  return { request, cancelled: () => cancelled };
}

describe("readBoundedBodyWithin", () => {
  test("gives up on a body that never ends, and cancels it", async () => {
    const { request, cancelled } = stalledRequest();
    const started = Date.now();
    await expect(readBoundedBodyWithin(request, 1024, 50)).rejects.toBeInstanceOf(RequestBodyTimeout);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cancelled()).toBe(true);
  });

  test("reads a body that arrives in time", async () => {
    const request = new Request("http://test/", { method: "PUT", body: "hello" });
    expect(new TextDecoder().decode(await readBoundedBodyWithin(request, 1024, 1_000))).toBe("hello");
  });

  test("still refuses a body over the limit, chunked or with a lying length", async () => {
    const big = new Uint8Array(2048);
    await expect(
      readBoundedBodyWithin(new Request("http://test/", { method: "PUT", body: big }), 1024, 1_000),
    ).rejects.toBeInstanceOf(RequestBodyTooLarge);
    const lying = new Request("http://test/", {
      method: "PUT",
      body: new ReadableStream({ start: (c) => { c.enqueue(big); c.close(); } }),
      headers: { "content-length": "10" },
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedBodyWithin(lying, 1024, 1_000)).rejects.toBeInstanceOf(RequestBodyTooLarge);
  });

  test("leaves readBoundedBody without a deadline", async () => {
    const request = new Request("http://test/", { method: "PUT", body: "x" });
    expect(await readBoundedBody(request, 10)).toEqual(new Uint8Array([120]));
  });
});

import { describe, expect, it } from "vitest";
import {
  API_ENTRYPOINT_METHODS,
  ORIGIN_KEY_HEADER,
  RemoteCallError,
  callRemote,
  decodeValue,
  encodeValue,
  isApiEntrypointMethod,
  isBridgeCallMethod,
  parseCallPath,
  rpcPath,
  secretsMatch,
  serveRemoteCall,
  assertStrongSecret,
} from "../src";

const KEY = "k".repeat(40);
const URL_BASE = "https://origin.test";

/** A target whose fetch serves the call in memory with `invoke`. */
function targetServedBy(invoke: (args: unknown[]) => unknown, key = KEY) {
  return {
    fetch: (request: Request) => serveRemoteCall(request, { keyHeader: ORIGIN_KEY_HEADER, key: KEY }, invoke),
    url: `${URL_BASE}${rpcPath("InternalApi", "addJobEvent")}`,
    keyHeader: ORIGIN_KEY_HEADER,
    key,
  };
}

describe("codec", () => {
  it("keeps the values that Workers RPC carries", () => {
    const value = {
      at: new Date("2026-10-24T10:00:00.000Z"),
      bytes: new Uint8Array([1, 2, 3]),
      tags: new Map([["a", 1]]),
      ids: new Set(["x"]),
      missing: undefined,
      big: 10n,
    };

    expect(decodeValue(encodeValue(value))).toEqual(value);
  });
});

describe("callRemote and serveRemoteCall", () => {
  it("returns the value of the remote call", async () => {
    const target = targetServedBy((args) => ({ received: args, at: new Date(0) }));

    await expect(callRemote(target, ["job-1", { type: "queued" }])).resolves.toEqual({
      received: ["job-1", { type: "queued" }],
      at: new Date(0),
    });
  });

  it("throws the remote error again with its name and message", async () => {
    const target = targetServedBy(() => {
      const error = new Error("Job job-1 does not exist.");
      error.name = "NotFoundError";
      throw error;
    });

    const failure = await callRemote(target, []).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RemoteCallError);
    expect(failure).toMatchObject({ name: "NotFoundError", message: "Job job-1 does not exist." });
  });

  it("does not follow a redirect, so the key stays with the target", async () => {
    const seen: string[] = [];
    const target = {
      fetch: async (request: Request) => {
        seen.push(request.url);
        if (request.redirect !== "manual") throw new Error("The call must not follow redirects.");
        return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      },
      url: `${URL_BASE}${rpcPath("InternalApi", "addJobEvent")}`,
      keyHeader: ORIGIN_KEY_HEADER,
      key: KEY,
    };

    await expect(callRemote(target, [])).rejects.toThrow(/HTTP 302/);
    expect(seen).toEqual([target.url]);
  });

  it("refuses a call with a wrong key", async () => {
    const target = targetServedBy(() => "never", "w".repeat(40));

    await expect(callRemote(target, [])).rejects.toThrow(/HTTP 401/);
  });

  it("refuses a body that is not an argument list", async () => {
    const response = await serveRemoteCall(
      new Request(URL_BASE, { method: "POST", headers: { [ORIGIN_KEY_HEADER]: KEY }, body: encodeValue({ not: "a list" }) }),
      { keyHeader: ORIGIN_KEY_HEADER, key: KEY },
      () => "never",
    );

    expect(response.status).toBe(400);
  });
});

describe("protocol", () => {
  it("parses call paths", () => {
    expect(parseCallPath("/__rpc/InternalApi/addJobEvent", "/__rpc/")).toEqual({
      target: "InternalApi",
      method: "addJobEvent",
    });
    expect(parseCallPath("/__rpc/InternalApi", "/__rpc/")).toBeNull();
    expect(parseCallPath("/__rpc/InternalApi/addJobEvent/extra", "/__rpc/")).toBeNull();
  });

  it("accepts only listed methods", () => {
    expect(isApiEntrypointMethod("InternalApi", "addJobEvent")).toBe(true);
    expect(isApiEntrypointMethod("InternalApi", "constructor")).toBe(false);
    expect(isBridgeCallMethod("GENERATION_QUEUE", "send")).toBe(true);
    expect(isBridgeCallMethod("GENERATION_QUEUE", "delete")).toBe(false);
  });

  it("lists the 39 RPC methods of the API", () => {
    expect(Object.values(API_ENTRYPOINT_METHODS).flat()).toHaveLength(39);
  });
});

describe("secrets", () => {
  it("matches only the exact key", () => {
    expect(secretsMatch(KEY, KEY)).toBe(true);
    expect(secretsMatch(`${KEY}x`, KEY)).toBe(false);
    expect(secretsMatch(KEY.slice(1), KEY)).toBe(false);
    expect(secretsMatch(null, KEY)).toBe(false);
  });

  it("rejects short keys at start-up", () => {
    expect(() => assertStrongSecret("ORIGIN_SHARED_SECRET", "short")).toThrow(/at least 32/);
    expect(assertStrongSecret("ORIGIN_SHARED_SECRET", KEY)).toBe(KEY);
  });
});

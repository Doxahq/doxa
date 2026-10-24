import { describe, expect, it, vi } from "vitest";

// The Node build aliases cloudflare:workers to this shim. The tests do the same.
vi.mock("cloudflare:workers", () => import("../../../src/runtime/node/workers-shim"));
import {
  API_ENTRYPOINT_METHODS,
  CLIENT_COUNTRY_HEADER,
  CLIENT_IP_HEADER,
  ORIGIN_KEY_HEADER,
  PUBLIC_URL_HEADER,
  callRemote,
  rpcPath,
} from "@doxahq/api-bridge";
import type { Env } from "../../../src/env";
import { BackgroundTasks } from "../../../src/runtime/node/background-tasks";
import { createCronHandler } from "../../../src/runtime/node/cron";
import { asPublicRequest, createOriginHandler } from "../../../src/runtime/node/origin-handler";
import { API_ENTRYPOINTS, createRpcHandler, type EntrypointClasses } from "../../../src/runtime/node/rpc-handler";

const KEY = "o".repeat(40);
const ORIGIN = "http://127.0.0.1:8786";
const env = {} as Env;

/** Entrypoint classes that record their calls, with the env and context they got. */
function recordingEntrypoints() {
  const calls: { entrypoint: string; method: string; args: unknown[] }[] = [];
  const make = (entrypoint: string) =>
    class {
      constructor(
        readonly ctx: ExecutionContext,
        readonly env: Env,
      ) {}
      addJobEvent(...args: unknown[]) {
        calls.push({ entrypoint, method: "addJobEvent", args });
        return { at: new Date(0), args };
      }
      validateToken() {
        throw new TypeError("Token expired.");
      }
    };
  const entrypoints: EntrypointClasses = {
    InternalApi: make("InternalApi"),
    PrerenderTaskApi: make("PrerenderTaskApi"),
    OAuthTokenValidator: make("OAuthTokenValidator"),
    AgentActionsApi: make("AgentActionsApi"),
    EmailDeliveryApi: make("EmailDeliveryApi"),
  };
  return { calls, entrypoints };
}

function originWith(overrides: Partial<Parameters<typeof createOriginHandler>[0]> = {}) {
  const tasks = new BackgroundTasks();
  const { calls, entrypoints } = recordingEntrypoints();
  const api = vi.fn(async (request: Request) => Response.json({ url: request.url, ip: request.headers.get("cf-connecting-ip") }));
  const handler = createOriginHandler({
    env,
    originKey: KEY,
    api,
    rpc: createRpcHandler({ env, originKey: KEY, createExecutionContext: () => tasks.createExecutionContext(), entrypoints }),
    cron: createCronHandler({ env, originKey: KEY, tasks, runJobs: () => {}, withLock: async (_env, work) => (await work(), true) }),
    createExecutionContext: () => tasks.createExecutionContext(),
    ...overrides,
  });
  return { handler, api, calls, tasks };
}

describe("origin key", () => {
  it("serves GET /health without the key, for the container health check", async () => {
    const { handler } = originWith();

    const response = await handler(new Request(`${ORIGIN}/health`));

    expect(response.status).toBe(200);
  });

  it("answers the unkeyed health check itself, whatever edge headers it carries", async () => {
    const { handler, api } = originWith();

    const response = await handler(
      new Request(`${ORIGIN}/health`, {
        headers: { [PUBLIC_URL_HEADER]: "https://api.doxa.so/projects", [CLIENT_IP_HEADER]: "1.2.3.4" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "doxa-api" });
    expect(api).not.toHaveBeenCalled();
  });

  it("refuses every other request without the key", async () => {
    const { handler, api } = originWith();

    for (const request of [
      new Request(`${ORIGIN}/me`),
      new Request(`${ORIGIN}/health`, { method: "POST" }),
      new Request(`${ORIGIN}/me`, { headers: { [ORIGIN_KEY_HEADER]: "x".repeat(40) } }),
    ]) {
      expect((await handler(request)).status).toBe(401);
    }
    expect(api).not.toHaveBeenCalled();
  });
});

describe("public requests", () => {
  it("reach the API with the public URL and the client IP", async () => {
    const { handler } = originWith();

    const response = await handler(
      new Request(`${ORIGIN}/me?x=1`, {
        headers: {
          [ORIGIN_KEY_HEADER]: KEY,
          [PUBLIC_URL_HEADER]: "https://api.doxa.so/me?x=1",
          [CLIENT_IP_HEADER]: "203.0.113.9",
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({ url: "https://api.doxa.so/me?x=1", ip: "203.0.113.9" });
  });

  it("drops client IP headers that a client could set itself", () => {
    const request = asPublicRequest(
      new Request(`${ORIGIN}/me`, { headers: { "x-real-ip": "6.6.6.6", "x-forwarded-for": "6.6.6.6, 7.7.7.7" } }),
    );

    expect(request.headers.get("x-real-ip")).toBeNull();
    expect(request.headers.get("x-forwarded-for")).toBeNull();
  });

  it("drops the edge headers and any client-sent Cloudflare IP", () => {
    const request = asPublicRequest(
      new Request(`${ORIGIN}/projects`, {
        method: "POST",
        body: "{}",
        headers: {
          [ORIGIN_KEY_HEADER]: KEY,
          [CLIENT_COUNTRY_HEADER]: "DE",
          "cf-connecting-ip": "10.0.0.1",
          "content-type": "application/json",
        },
      }),
    );

    expect(request.headers.get(ORIGIN_KEY_HEADER)).toBeNull();
    expect(request.headers.get("cf-connecting-ip")).toBeNull();
    expect(request.headers.get("cf-ipcountry")).toBe("DE");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.url).toBe(`${ORIGIN}/projects`);
  });

  it("ignores a public URL that is not http(s)", () => {
    const request = asPublicRequest(
      new Request(`${ORIGIN}/me`, { headers: { [PUBLIC_URL_HEADER]: "javascript:alert(1)" } }),
    );

    expect(request.url).toBe(`${ORIGIN}/me`);
  });
});

describe("RPC route", () => {
  const callThrough = (handler: (request: Request) => Promise<Response>, entrypoint: string, method: string, args: unknown[]) =>
    callRemote(
      { fetch: handler, url: `${ORIGIN}${rpcPath(entrypoint, method)}`, keyHeader: ORIGIN_KEY_HEADER, key: KEY },
      args,
    );

  it("calls the method on a new entrypoint instance and returns its value", async () => {
    const { handler, calls } = originWith();

    const result = await callThrough(handler, "InternalApi", "addJobEvent", ["job-1", { type: "queued", at: new Date(5) }]);

    expect(result).toEqual({ at: new Date(0), args: ["job-1", { type: "queued", at: new Date(5) }] });
    expect(calls).toEqual([{ entrypoint: "InternalApi", method: "addJobEvent", args: ["job-1", { type: "queued", at: new Date(5) }] }]);
  });

  it("throws the method's error at the caller", async () => {
    const { handler } = originWith();

    await expect(callThrough(handler, "OAuthTokenValidator", "validateToken", ["mcp", "t"])).rejects.toMatchObject({
      name: "TypeError",
      message: "Token expired.",
    });
  });

  it("refuses methods that are not listed, also inherited ones", async () => {
    const { handler } = originWith();

    for (const path of ["/__rpc/InternalApi/constructor", "/__rpc/InternalApi/toString", "/__rpc/Nope/addJobEvent"]) {
      const response = await handler(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { [ORIGIN_KEY_HEADER]: KEY } }));
      expect(response.status).toBe(404);
    }
  });
});

describe("cron route", () => {
  const tick = (body: unknown) =>
    new Request(`${ORIGIN}/__cron`, { method: "POST", headers: { [ORIGIN_KEY_HEADER]: KEY }, body: JSON.stringify(body) });

  it("starts the jobs in the background and answers at once", async () => {
    const tasks = new BackgroundTasks();
    const runJobs = vi.fn((_time: number, _env: Env, context: ExecutionContext) => {
      context.waitUntil(Promise.resolve());
    });
    const handler = createCronHandler({ env, originKey: KEY, tasks, runJobs, withLock: async (_env, work) => (await work(), true) });

    const response = await handler(tick({ scheduledTime: 1_700_000_000_000 }));
    await tasks.settled();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "started" });
    expect(runJobs).toHaveBeenCalledWith(1_700_000_000_000, env, expect.anything());
  });

  it("skips a tick while the previous one runs", async () => {
    const tasks = new BackgroundTasks();
    let finish = () => {};
    const handler = createCronHandler({
      env,
      originKey: KEY,
      tasks,
      runJobs: (_time, _env, context) => context.waitUntil(new Promise<void>((resolve) => (finish = resolve))),
      withLock: async (_env, work) => (await work(), true),
    });

    await handler(tick({ scheduledTime: 1 }));
    const second = await handler(tick({ scheduledTime: 2 }));
    finish();
    await tasks.settled();

    await expect(second.json()).resolves.toMatchObject({ status: "skipped" });
  });

  it("does not run the jobs when another task holds the lock", async () => {
    const tasks = new BackgroundTasks();
    const runJobs = vi.fn();
    const handler = createCronHandler({ env, originKey: KEY, tasks, runJobs, withLock: async () => false });

    await handler(tick({ scheduledTime: 1 }));
    await tasks.settled();

    expect(runJobs).not.toHaveBeenCalled();
  });

  it("refuses a body without scheduledTime", async () => {
    const { handler } = originWith();

    expect((await handler(tick({ when: "now" }))).status).toBe(400);
  });
});

describe("API entrypoints", () => {
  it("list every public method of each entrypoint class", () => {
    for (const [name, entrypoint] of Object.entries(API_ENTRYPOINTS)) {
      const methods = Object.getOwnPropertyNames(entrypoint.prototype).filter(
        (method) => method !== "constructor" && !isPrivateHelper(name, method),
      );
      expect([...methods].sort(), name).toEqual([...API_ENTRYPOINT_METHODS[name as keyof typeof API_ENTRYPOINT_METHODS]].sort());
    }
  });
});

/** TypeScript `private` methods exist at run time. These are not RPC methods. */
function isPrivateHelper(entrypoint: string, method: string): boolean {
  return (entrypoint === "PrerenderTaskApi" && method === "repository") || (entrypoint === "AgentActionsApi" && method === "handler");
}

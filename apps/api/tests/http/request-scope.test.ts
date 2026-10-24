import { createDb } from "@doxahq/db";
import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";
import { requestState } from "../../src/http/request-state";
import { withRequestScope } from "../../src/http/request-scope";
import { createApiServerTiming } from "../../src/http/server-timing";

function fakePools() {
  const pools: Array<{ end: ReturnType<typeof vi.fn> }> = [];
  const createPool = () => {
    const pool = { end: vi.fn(async () => undefined) };
    pools.push(pool);
    return pool as unknown as Pool;
  };
  return {
    pools,
    createPool,
    ended: () => pools.filter((pool) => pool.end.mock.calls.length > 0).length,
  };
}

/** An execution context that lets a test wait for every `waitUntil` promise. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise.catch(() => undefined));
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return {
    context,
    async drain() {
      for (let index = 0; index < pending.length; index++) {
        await pending[index];
      }
      // The close waits a few turns after the last tracked promise.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    },
  };
}

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const env = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  WEB_ORIGIN: "https://doxa.so",
} as unknown as Env;

describe("one database scope per request", () => {
  test("every createDb of a request shares one pool, closed after the response", async () => {
    const pools = fakePools();
    const fetch = withRequestScope(
      async (_request, scopedEnv) => {
        expect(createDb(scopedEnv)).toBe(createDb(scopedEnv));
        return new Response("ok");
      },
      { createPool: pools.createPool },
    );
    const ctx = executionContext();

    const response = await fetch(new Request("https://api.doxa.so/x"), env, ctx.context);
    await ctx.drain();

    expect(await response.text()).toBe("ok");
    expect(pools.pools).toHaveLength(1);
    expect(pools.ended()).toBe(1);
  });

  test("two requests never share a pool", async () => {
    const pools = fakePools();
    const fetch = withRequestScope(
      async (_request, scopedEnv) => {
        createDb(scopedEnv);
        return new Response("ok");
      },
      { createPool: pools.createPool },
    );
    const first = executionContext();
    const second = executionContext();

    await Promise.all([
      fetch(new Request("https://api.doxa.so/a"), env, first.context),
      fetch(new Request("https://api.doxa.so/b"), env, second.context),
    ]);
    await Promise.all([first.drain(), second.drain()]);

    expect(pools.pools).toHaveLength(2);
    expect(pools.ended()).toBe(2);
  });

  test("the scope stays open until background work ends, also work that it starts", async () => {
    const pools = fakePools();
    const background = gate();
    let usedAfterResponse = false;
    const fetch = withRequestScope(
      async (_request, scopedEnv, context) => {
        createDb(scopedEnv);
        context.waitUntil(
          background.opened.then(() => {
            context.waitUntil(
              Promise.resolve().then(() => {
                createDb(scopedEnv);
                usedAfterResponse = true;
              }),
            );
          }),
        );
        return new Response("ok");
      },
      { createPool: pools.createPool },
    );
    const ctx = executionContext();

    await fetch(new Request("https://api.doxa.so/x"), env, ctx.context);
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(pools.ended()).toBe(0);

    background.open();
    await ctx.drain();

    expect(usedAfterResponse).toBe(true);
    expect(pools.ended()).toBe(1);
  });

  test("an event stream keeps the scope open until the stream ends", async () => {
    const pools = fakePools();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = withRequestScope(
      async (_request, scopedEnv) => {
        createDb(scopedEnv);
        const body = new ReadableStream<Uint8Array>({
          start: (streamController) => {
            controller = streamController;
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { createPool: pools.createPool },
    );
    const ctx = executionContext();

    const response = await fetch(new Request("https://api.doxa.so/stream"), env, ctx.context);
    const reader = response.body!.getReader();
    controller.enqueue(new TextEncoder().encode("event: stage\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "event: stage\n\n",
    );
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(pools.ended()).toBe(0);

    controller.close();
    expect((await reader.read()).done).toBe(true);
    await ctx.drain();

    expect(pools.ended()).toBe(1);
  });

  test("an event stream closes the scope when the client leaves", async () => {
    const pools = fakePools();
    const fetch = withRequestScope(
      async (_request, scopedEnv) => {
        createDb(scopedEnv);
        return new Response(new ReadableStream<Uint8Array>(), {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
      { createPool: pools.createPool },
    );
    const ctx = executionContext();

    const response = await fetch(new Request("https://api.doxa.so/stream"), env, ctx.context);
    await response.body!.cancel();
    await ctx.drain();

    expect(pools.ended()).toBe(1);
  });

  test("the execution context still passes props through", async () => {
    const ctx = executionContext();
    const fetch = withRequestScope(
      async (_request, _env, context) => {
        (context as unknown as { props: unknown }).props = { grant: "g-1" };
        return Response.json(context.props);
      },
      { createPool: fakePools().createPool },
    );

    const response = await fetch(new Request("https://api.doxa.so/x"), env, ctx.context);

    expect(await response.json()).toEqual({ grant: "g-1" });
    expect(ctx.context.props).toEqual({ grant: "g-1" });
  });

  test("a handler error still closes the scope", async () => {
    const pools = fakePools();
    const fetch = withRequestScope(
      async (_request, scopedEnv) => {
        createDb(scopedEnv);
        throw new Error("boom");
      },
      { createPool: pools.createPool },
    );
    const ctx = executionContext();

    await expect(
      fetch(new Request("https://api.doxa.so/x"), env, ctx.context),
    ).rejects.toThrow("boom");
    await ctx.drain();

    expect(pools.ended()).toBe(1);
  });
});

describe("per-request response headers", () => {
  function timedFetch(
    run: (request: Request) => void | Promise<void> = () => undefined,
  ) {
    let clock = 0;
    return withRequestScope(
      async (request) => {
        await run(request);
        return new Response("ok");
      },
      { createPool: fakePools().createPool, now: () => (clock += 5) },
    );
  }

  test("DEBUG adds Server-Timing with the total, readable by the web origin", async () => {
    const fetch = timedFetch((request) =>
      requestState(request, { DEBUG: "true" }).timing.add("auth", 12.345),
    );

    const response = await fetch(
      new Request("https://api.doxa.so/x", { headers: { origin: "https://doxa.so" } }),
      { ...env, DEBUG: "true" },
      executionContext().context,
    );

    expect(response.headers.get("server-timing")).toBe("auth;dur=12.35, total;dur=5");
    expect(response.headers.get("timing-allow-origin")).toBe("https://doxa.so");
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "Server-Timing",
    );
  });

  test("a platform admin gets Server-Timing without DEBUG", async () => {
    const fetch = timedFetch(async (request) => {
      const { timing } = requestState(request, env);
      await timing.measure("auth", async () => undefined);
      timing.setViewer({ isAdmin: true });
    });

    const response = await fetch(new Request("https://api.doxa.so/x"), env, executionContext().context);

    expect(response.headers.get("server-timing")).toMatch(/^auth;dur=\d+(\.\d+)?, total;dur=5$/);
    // No origin, so no cross-origin timing header.
    expect(response.headers.get("timing-allow-origin")).toBeNull();
  });

  test("other users and anonymous requests get no Server-Timing", async () => {
    const user = timedFetch((request) => {
      requestState(request, env).timing.setViewer({ isAdmin: false });
    });
    const anonymous = timedFetch();

    for (const fetch of [user, anonymous]) {
      const response = await fetch(
        new Request("https://api.doxa.so/x", { headers: { origin: "https://doxa.so" } }),
        env,
        executionContext().context,
      );
      expect(response.headers.get("server-timing")).toBeNull();
      expect(response.headers.get("timing-allow-origin")).toBeNull();
    }
  });

  test("an untrusted origin gets no Timing-Allow-Origin", async () => {
    const fetch = timedFetch();

    const response = await fetch(
      new Request("https://api.doxa.so/x", { headers: { origin: "https://evil.example" } }),
      { ...env, DEBUG: "true" },
      executionContext().context,
    );

    expect(response.headers.get("server-timing")).toBe("total;dur=5");
    expect(response.headers.get("timing-allow-origin")).toBeNull();
  });

  test("the session cookie cache value goes on the response", async () => {
    const fetch = timedFetch((request) => {
      requestState(request, env).setCookies.push(
        "better-auth.session_data=abc; Path=/; HttpOnly",
      );
    });

    const response = await fetch(new Request("https://api.doxa.so/x"), env, executionContext().context);

    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_data=abc; Path=/; HttpOnly",
    ]);
    expect(await response.text()).toBe("ok");
  });
});

describe("the API Server-Timing recorder", () => {
  test("records nothing more once the viewer is not an admin", async () => {
    const timing = createApiServerTiming(undefined);
    timing.add("auth", 3);
    timing.setViewer({ isAdmin: false });
    const step = vi.fn(async () => "result");

    expect(await timing.measure("access", step)).toBe("result");
    expect(step).toHaveBeenCalledTimes(1);
    expect(timing.recording).toBe(false);
    expect(timing.entries()).toEqual([]);
    expect(timing.headerValue()).toBeNull();
  });

  test("keeps the measurements taken before an admin is known", () => {
    let clock = 0;
    const timing = createApiServerTiming("false", () => (clock += 10));
    timing.add("auth", 4);
    timing.setViewer({ isAdmin: true });
    timing.add("db.resolve", 1.5);

    expect(timing.headerValue()).toBe("auth;dur=4, db.resolve;dur=1.5");
  });

  test("DEBUG ignores the viewer", () => {
    const timing = createApiServerTiming(" TRUE ");
    timing.setViewer({ isAdmin: false });
    timing.add("auth", 1);

    expect(timing.allowed).toBe(true);
    expect(timing.headerValue()).toBe("auth;dur=1");
  });

  test("measures a failed step too", async () => {
    let clock = 0;
    const timing = createApiServerTiming("true", () => (clock += 7));

    await expect(
      timing.measure("r2.page", async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(timing.headerValue()).toBe("r2.page;dur=7");
  });
});

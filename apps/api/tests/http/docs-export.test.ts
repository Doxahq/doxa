import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/env";
import type { ExportBilling, ExportQuotaView } from "../../src/services/billing/export-billing";
import { ExportBillingUnavailableError } from "../../src/services/billing/export-billing";
import type { DocsExportPlan, DocsExportStreamHooks } from "../../src/services/docs-export/service";

const mocks = vi.hoisted(() => ({
  allowed: true,
  capability: null as string | null,
}));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../../src/http/project-access", () => ({
  withProjectAccess: async (
    _context: unknown,
    capability: string,
    handler: (access: { projectId: string; actorUserId: string; ownerUserId: string }) => Promise<Response>,
  ) => {
    mocks.capability = capability;
    if (!mocks.allowed) return new Response(null, { status: 404 });
    return handler({ projectId: "project-1", actorUserId: "editor-1", ownerUserId: "owner-1" });
  },
}));

const { createDocsExportRoutes } = await import("../../src/routes/docs-export");

const VERSION = { id: "v1", number: 3, publishedAt: "2026-11-15T09:00:00.000Z" };
const SPENT: ExportQuotaView = { available: false, plan: "free", windowHours: 24, resetsAt: "2099-01-01T00:00:00.000Z" };

interface Setup {
  plan?: DocsExportPlan["kind"];
  reserve?: ExportBilling["reserve"];
  status?: ExportBilling["status"];
  stream?: (hooks: DocsExportStreamHooks) => ReadableStream<Uint8Array>;
}

function setup(options: Setup = {}) {
  const release = vi.fn(async () => {});
  const hooks: DocsExportStreamHooks[] = [];
  const open = vi.fn((streamHooks: DocsExportStreamHooks) => {
    hooks.push(streamHooks);
    return options.stream?.(streamHooks) ?? new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([80, 75]));
        controller.close();
        streamHooks.onComplete?.();
      },
    });
  });
  const plan: DocsExportPlan =
    options.plan === "no_published_version"
      ? { kind: "no_published_version" }
      : options.plan === "too_large"
        ? { kind: "too_large", version: VERSION, sizeBytes: 2e9, fileCount: 3 }
        : { kind: "ready", version: VERSION, sizeBytes: 100, fileCount: 3, fileName: "acme-docs-2026-11-16.zip", open };
  const prepare = vi.fn(async () => plan);
  const reserve = vi.fn(
    options.reserve ?? (async () => ({ allowed: true as const, quota: { ...SPENT, plan: "pro", windowHours: 1 }, release })),
  );
  const status = vi.fn(options.status ?? (async () => ({ available: true, plan: "pro", windowHours: 1, resetsAt: null })));
  const app = createDocsExportRoutes({
    exports: () => ({ prepare }),
    billing: () => ({ mode: "on", reserve, status }),
  });
  return { app, prepare, reserve, status, release, open, hooks };
}

const env = {} as Env;
const sameSite = { headers: { "sec-fetch-site": "same-site" } };

beforeEach(() => {
  mocks.allowed = true;
  mocks.capability = null;
});

describe("docs export routes", () => {
  test("stream the zip to an editor, uncached, as an attachment", async () => {
    const { app, prepare, reserve } = setup();
    const response = await app.request("/", sameSite, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="acme-docs-2026-11-16.zip"');
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([80, 75]);
    expect(mocks.capability).toBe("docs.write");
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "owner-1", projectId: "project-1" }));
    expect(reserve).toHaveBeenCalledWith("project-1");
  });

  test("hide the project from someone without access", async () => {
    mocks.allowed = false;
    const { app, prepare, reserve } = setup();
    expect((await app.request("/", sameSite, env)).status).toBe(404);
    expect((await app.request("/status", {}, env)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("refuse a download that another site started, before any read or count", async () => {
    const { app, prepare, reserve } = setup();
    const response = await app.request("/", { headers: { "sec-fetch-site": "cross-site" } }, env);
    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("answer 404 without a published version and 413 above the cap, without spending the quota", async () => {
    for (const [plan, status] of [["no_published_version", 404], ["too_large", 413]] as const) {
      const { app, reserve } = setup({ plan });
      const response = await app.request("/", sameSite, env);
      expect(response.status).toBe(status);
      expect(reserve).not.toHaveBeenCalled();
    }
  });

  test("answer 429 with the reset time when the quota is spent", async () => {
    const { app, open } = setup({ reserve: async () => ({ allowed: false, quota: SPENT }) });
    const response = await app.request("/", sameSite, env);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: { details: { code: "export_limit", resetsAt: SPENT.resetsAt, windowHours: 24 } } });
    expect(open).not.toHaveBeenCalled();
  });

  test("answer 503 and never stream when billing fails", async () => {
    const { app, open } = setup({ reserve: async () => { throw new ExportBillingUnavailableError(new Error("db")); } });
    expect((await app.request("/", sameSite, env)).status).toBe(503);
    expect(open).not.toHaveBeenCalled();
  });

  test("allow one open export per project, and free the slot at the end", async () => {
    let finish: (() => void) | null = null;
    const { app } = setup({
      stream: (hooks) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            finish = () => {
              controller.close();
              hooks.onComplete?.();
            };
          },
        }),
    });
    const first = await app.request("/", sameSite, env);
    expect(first.status).toBe(200);
    const second = await app.request("/", sameSite, env);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { details: { code: "export_in_progress" } } });
    finish!();
    await first.arrayBuffer();
    expect((await app.request("/", sameSite, env)).status).toBe(200);
  });

  test("give the quota back on a server failure, not on a client cancel", async () => {
    const { app, release, hooks } = setup({ stream: () => new ReadableStream<Uint8Array>({ start() {} }) });
    await app.request("/", sameSite, env);
    hooks[0]!.onCancel?.();
    expect(release).not.toHaveBeenCalled();
    await app.request("/", sameSite, env);
    hooks[1]!.onError?.(new Error("r2 down"), { bytesSent: 0 });
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("keep the export counted when a server failure comes late in the download", async () => {
    const { app, release, hooks } = setup({ stream: () => new ReadableStream<Uint8Array>({ start() {} }) });
    await app.request("/", sameSite, env);
    // The plan is 100 bytes: 10 bytes is the refund limit.
    hooks[0]!.onError?.(new Error("r2 down"), { bytesSent: 10 });
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
  });

  test("refuse HEAD, before any count", async () => {
    const { app, reserve, open } = setup();
    const response = await app.request("/", { method: "HEAD", ...sameSite }, env);
    expect(response.status).toBe(405);
    expect(reserve).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("send a browser navigation back to the settings page on an error", async () => {
    const { app } = setup({ reserve: async () => ({ allowed: false, quota: SPENT }) });
    const navigate = { headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" } };
    const response = await app.request("/", navigate, { WEB_ORIGIN: "https://doxa.so" } as Env);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://doxa.so/dashboard/projects/project-1/settings?export_error=export_limit");
    // Without a configured dashboard origin, the plain error stays.
    expect((await app.request("/", navigate, env)).status).toBe(429);
    // A fetch keeps the JSON error.
    expect((await app.request("/", sameSite, { WEB_ORIGIN: "https://doxa.so" } as Env)).status).toBe(429);
  });

  test("pass the time limits to the stream", async () => {
    const { app, hooks } = setup();
    await (await app.request("/", sameSite, env)).arrayBuffer();
    expect(hooks[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(hooks[0]!.idleTimeoutMs).toBe(60_000);
  });

  test("status: available, spent, unpublished and billing down", async () => {
    expect(await (await setup().app.request("/status", {}, env)).json()).toMatchObject({ available: true, reason: null, version: VERSION, sizeBytes: 100 });
    expect(await (await setup({ status: async () => SPENT }).app.request("/status", {}, env)).json()).toMatchObject({
      available: false,
      reason: "quota_spent",
      quota: SPENT,
    });
    expect(await (await setup({ plan: "no_published_version" }).app.request("/status", {}, env)).json()).toMatchObject({
      available: false,
      reason: "no_published_version",
      version: null,
    });
    const down = setup({ status: async () => { throw new ExportBillingUnavailableError(new Error("db")); } });
    expect((await down.app.request("/status", {}, env)).status).toBe(503);
  });

  test("status never counts an export", async () => {
    const { app, reserve } = setup();
    await app.request("/status", {}, env);
    expect(reserve).not.toHaveBeenCalled();
  });
});

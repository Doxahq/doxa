import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import { DocsRegionalWarmer } from "../../src/warm/docs-regional-warmer";
import { DocsWarmControl } from "../../src/warm/docs-warm-control";
import { startWarmer } from "../../src/warm/warm-warmer";
import { MemoryStorage, RELEASE, objectState, warmJob } from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("regional warmer object", () => {
  test("drops its job when it cannot build its bindings, instead of keeping the state", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    await startWarmer(storage, warmJob({ startedAt: Date.now() }), Date.now());
    const warmer = new DocsRegionalWarmer(objectState(storage) as never, {} as never);
    await warmer.alarm();
    expect(storage.values.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });
});

describe("deploy sweep tick", () => {
  function createControl(stored: unknown) {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    if (stored) storage.values.set("sweep", stored);
    const freeSlots = vi.fn(async () => 24);
    const env = {
      DOXA_PROD_WARM_MODE: "all",
      DOXA_PROD_WARM_DEPLOY_SWEEP: "on",
      DOCS_HOSTNAME_MAP: {
        list: vi.fn(async () => ({ keys: [], list_complete: true })),
        get: vi.fn(async () => null),
      },
      DOCS_WARM_SWEEP_QUEUE: { sendBatch: vi.fn(async () => undefined) },
      DOCS_WARM_CONTROL: { idFromName: (name: string) => name, get: () => ({ freeSlots }) },
    };
    const control = new DocsWarmControl(objectState(storage) as never, env as never);
    return { control, freeSlots };
  }

  const done = (rollout: string) => ({
    releaseId: RELEASE,
    rollout,
    cursor: null,
    offset: 0,
    done: true,
    enqueued: 3,
    startedAt: 1,
  });

  test("a finished sweep of the same release and rollout makes no slots call", async () => {
    const { control, freeSlots } = createControl(done("all"));
    await control.sweepTick({ releaseId: RELEASE });
    expect(freeSlots).not.toHaveBeenCalled();
  });

  test("a new rollout still sweeps", async () => {
    const { control, freeSlots } = createControl(done("allowlist:site-1"));
    await control.sweepTick({ releaseId: RELEASE });
    expect(freeSlots).toHaveBeenCalledOnce();
  });
});

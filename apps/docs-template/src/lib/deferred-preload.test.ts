import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPreloadQueue,
  resetDeferredPreloadForTests,
  whenPageIdleAfterLoad,
} from "./deferred-preload";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetDeferredPreloadForTests();
  vi.unstubAllGlobals();
});

describe("preload queue", () => {
  test("runs at most the limit at once and starts the next as one ends", async () => {
    const queue = createPreloadQueue(2);
    const tasks = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    tasks.forEach((task, index) =>
      queue.schedule(`/page-${index}`, () => {
        started.push(index);
        return task.promise;
      })
    );

    expect(started).toEqual([0, 1]);
    tasks[0]!.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
  });

  test("preloads each key once", () => {
    const queue = createPreloadQueue(2);
    const task = vi.fn(async () => undefined);
    queue.schedule("/guide", task);
    queue.schedule("/guide", task);
    expect(task).toHaveBeenCalledOnce();
  });

  test("a failed preload frees its slot", async () => {
    const queue = createPreloadQueue(1);
    const next = vi.fn(async () => undefined);
    queue.schedule("/broken", async () => {
      throw new Error("offline");
    });
    queue.schedule("/next", next);
    await flush();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("whenPageIdleAfterLoad", () => {
  function stubBrowser(readyState: DocumentReadyState) {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("document", { readyState });
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) =>
        listeners.set(type, listener),
      requestIdleCallback: (callback: () => void) => callback(),
      setTimeout,
    });
    return { fireLoad: () => listeners.get("load")?.() };
  }

  test("waits for the load event while the page is loading", async () => {
    const browser = stubBrowser("interactive");
    const ready = vi.fn();
    void whenPageIdleAfterLoad().then(ready);

    await flush();
    expect(ready).not.toHaveBeenCalled();
    browser.fireLoad();
    await flush();
    expect(ready).toHaveBeenCalledOnce();
  });

  test("resolves at the next idle time when the page has loaded", async () => {
    stubBrowser("complete");
    await expect(whenPageIdleAfterLoad()).resolves.toBeUndefined();
  });
});

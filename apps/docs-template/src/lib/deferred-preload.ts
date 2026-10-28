import { useEffect, type RefObject } from "react";

/**
 * Viewport preloading for aggressive navigation. A visible link preloads its
 * route only after the page has loaded and the browser is idle, and the
 * shared queue runs a few preloads at a time. On a cold region every preload
 * starts a server render, so a burst of them both competes with the page's
 * own loading and starts many cold renders at once.
 */
export const MAX_CONCURRENT_PRELOADS = 2;
const IDLE_TIMEOUT_MS = 2_000;

type PreloadTask = () => Promise<unknown>;

export interface PreloadQueue {
  /** Queues a preload once per key. A failed preload is not retried. */
  schedule(key: string, task: PreloadTask): void;
}

export function createPreloadQueue(limit: number): PreloadQueue {
  const seen = new Set<string>();
  const waiting: PreloadTask[] = [];
  let running = 0;

  const runNext = () => {
    while (running < limit && waiting.length > 0) {
      const task = waiting.shift();
      if (!task) return;
      running += 1;
      task()
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          runNext();
        });
    }
  };

  return {
    schedule(key, task) {
      if (seen.has(key)) return;
      seen.add(key);
      waiting.push(task);
      runNext();
    },
  };
}

let pageReady: Promise<void> | undefined;

/** Resolves after the `load` event, once the browser is idle. */
export function whenPageIdleAfterLoad(): Promise<void> {
  pageReady ??= new Promise((resolve) => {
    const afterIdle = () => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => resolve(), {
          timeout: IDLE_TIMEOUT_MS,
        });
      } else {
        window.setTimeout(resolve, 0);
      }
    };
    if (document.readyState === "complete") afterIdle();
    else window.addEventListener("load", afterIdle, { once: true });
  });
  return pageReady;
}

const sharedPreloadQueue = createPreloadQueue(MAX_CONCURRENT_PRELOADS);

/**
 * Preloads `key` through the shared queue once the element is visible, but not
 * before the page has loaded.
 */
export function useDeferredViewportPreload(
  ref: RefObject<Element | null>,
  input: { enabled: boolean; key: string; preload: PreloadTask }
): void {
  const { enabled, key, preload } = input;

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    let observer: IntersectionObserver | undefined;
    let cancelled = false;

    void whenPageIdleAfterLoad().then(() => {
      const element = ref.current;
      if (cancelled || !element) return;
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        sharedPreloadQueue.schedule(key, preload);
      });
      observer.observe(element);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [enabled, key, preload, ref]);
}

/** Test hook: forget the page-load state between tests. */
export function resetDeferredPreloadForTests(): void {
  pageReady = undefined;
}

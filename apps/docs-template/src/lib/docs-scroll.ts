import { useLayoutEffect } from "react";
import { useRouterState, type AnyRouter } from "@tanstack/react-router";

import { APP_SCROLL_CONTAINER_ID } from "@/src/lib/toc";

/**
 * The router's restoration id for the docs scroll container. The router saves
 * the container's position under this key, and the inline script in
 * `__root.tsx` reads it back on a refresh.
 */
export const DOCS_SCROLL_RESTORATION_ID = "docs-content";

/** True from a new history entry (a link, a redirect) until its page shows. */
let resetPending = false;

function scrollDocsToTop() {
  document
    .getElementById(APP_SCROLL_CONTAINER_ID)
    ?.scrollTo({ top: 0, behavior: "instant" });
}

/**
 * The docs content scrolls inside `#app-scroll-container`, not the window.
 *
 * The router restores the container's position on Back, Forward and refresh.
 * It must not list the container in `scrollToTopSelectors`: the router resets
 * those elements to the top after any navigation that does not restore the
 * window, so it undid every restore here.
 *
 * Instead, a new history entry without a #hash opens at the top, the way a
 * new page does. `useDocsScrollReset` does it before the new page paints.
 * This handler does it again after the router's own handler, which copies
 * the previous page's position to the new entry. A URL with a #hash is left
 * to the hash scroll.
 */
export function resetDocsScrollOnNewPage(router: AnyRouter): () => void {
  if (typeof window === "undefined") return () => undefined;

  const stopHistory = router.history.subscribe(
    ({ location, action }: { location: { hash: string }; action: { type: string } }) => {
      resetPending =
        (action.type === "PUSH" || action.type === "REPLACE") && !location.hash;
    }
  );
  const stopRendered = router.subscribe("onRendered", () => {
    if (!resetPending) return;
    resetPending = false;
    // After the router's handler for this event. Before the next paint.
    queueMicrotask(scrollDocsToTop);
  });
  return () => {
    stopHistory();
    stopRendered();
  };
}

/**
 * Puts a new page at the top in the same commit that shows it. The router's
 * `onRendered` comes later, so without this the new page paints at the old
 * page's position first.
 */
export function useDocsScrollReset(): void {
  const pathname = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.pathname,
  });
  useLayoutEffect(() => {
    if (resetPending) scrollDocsToTop();
  }, [pathname]);
}

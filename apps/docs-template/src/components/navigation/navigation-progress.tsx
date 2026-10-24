import { useRouterState } from "@tanstack/react-router";

import { useDelayedFlag } from "@/src/hooks/use-delayed-flag";

/** Long enough that a cached navigation finishes before the bar appears. */
const NAVIGATION_PROGRESS_DELAY_MS = 150;

/**
 * A thin bar at the top of the viewport while a client navigation loads. The
 * current page stays on screen. Hover preloads do not change the router
 * status, so they never show the bar.
 */
export function NavigationProgress() {
  const isNavigating = useRouterState({
    select: (state) => state.status === "pending",
  });
  const isVisible = useDelayedFlag(isNavigating, NAVIGATION_PROGRESS_DELAY_MS);
  if (!isVisible) return null;

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden"
    >
      <div className="navigation-progress-bar h-full w-1/4 bg-primary" />
    </div>
  );
}

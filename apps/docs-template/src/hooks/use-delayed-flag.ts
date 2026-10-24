import { useEffect, useState } from "react";

/**
 * Returns `true` only after `active` stays `true` for `delayMs`, and `false`
 * as soon as `active` ends. Short activity never shows.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);

  return active && elapsed;
}

/**
 * Server-Timing for the API. The header format is the same as in
 * `apps/docs-dispatcher/src/server-timing.ts`: `name;dur=12.5`.
 *
 * The header goes out only when `DEBUG` is "true", or when the session user is
 * a platform admin. Until the session is known, the recorder keeps its
 * measurements. When the user is not an admin, it drops them and measures
 * nothing more, so a normal request pays for one clock read at most.
 */
export interface ServerTimingEntry {
  name: string;
  durationMs: number;
}

export interface ApiServerTiming {
  /** True while the recorder keeps measurements. */
  readonly recording: boolean;
  /** True when the response may carry the header. */
  readonly allowed: boolean;
  add(name: string, durationMs: number): void;
  measure<T>(name: string, operation: () => Promise<T> | T): Promise<T>;
  /** Called when the session user is known. */
  setViewer(viewer: { isAdmin: boolean }): void;
  entries(): readonly ServerTimingEntry[];
  headerValue(): string | null;
}

type Clock = () => number;

type TimingState = "debug" | "pending" | "admin" | "off";

export function createApiServerTiming(
  debug: string | undefined,
  now: Clock = () => performance.now(),
): ApiServerTiming {
  let state: TimingState =
    debug?.trim().toLowerCase() === "true" ? "debug" : "pending";
  let measurements: ServerTimingEntry[] = [];
  const recording = () => state !== "off";

  const add = (name: string, durationMs: number): void => {
    if (!recording()) return;
    measurements.push({ name, durationMs: Math.max(0, durationMs) });
  };

  return {
    get recording() {
      return recording();
    },
    get allowed() {
      return state === "debug" || state === "admin";
    },
    add,
    async measure(name, operation) {
      if (!recording()) return operation();
      const startedAt = now();
      try {
        return await operation();
      } finally {
        add(name, now() - startedAt);
      }
    },
    setViewer({ isAdmin }) {
      if (state !== "pending") return;
      state = isAdmin ? "admin" : "off";
      if (state === "off") measurements = [];
    },
    entries() {
      return measurements;
    },
    headerValue() {
      if (state !== "debug" && state !== "admin") return null;
      if (measurements.length === 0) return null;
      return measurements.map(formatEntry).join(", ");
    },
  };
}

function formatEntry(entry: ServerTimingEntry): string {
  return `${entry.name};dur=${Number(entry.durationMs.toFixed(2))}`;
}

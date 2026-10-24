import type { ContainerGenerateHeartbeatRecord } from "@doxahq/contracts";

export const GENERATION_HEARTBEAT_INTERVAL_MS = 10_000;

export function startGenerationHeartbeat(
  write: (record: ContainerGenerateHeartbeatRecord) => void,
): () => void {
  const startedAt = Date.now();
  const interval = setInterval(() => {
    write({
      kind: "heartbeat",
      elapsedMs: Date.now() - startedAt,
    });
  }, GENERATION_HEARTBEAT_INTERVAL_MS);
  interval.unref();

  return () => clearInterval(interval);
}

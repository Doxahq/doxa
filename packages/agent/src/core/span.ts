import type { AgentSpanCallback, AgentSpanRecord } from "./types";

export async function emitAgentSpan(
  callback: AgentSpanCallback | undefined,
  span: AgentSpanRecord,
): Promise<void> {
  if (!callback) return;

  await Promise.resolve(callback(span)).catch((error: unknown) => {
    console.error(JSON.stringify({
      service: "doxa-agent",
      eventType: "span_sink_failed",
      spanKind: span.kind,
      spanName: span.name,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}

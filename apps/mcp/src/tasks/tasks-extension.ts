import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * The MCP Tasks extension (SEP-2663, `io.modelcontextprotocol/tasks`) on the
 * 2026-07-28 protocol. SDK 2.3 serves `tasks/get` and `tasks/cancel` for it,
 * but has no task runtime: Doxa builds each task from an approval request.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** Declared on every capability object that supports the extension. */
export const TASKS_EXTENSION_CAPABILITY = {
  extensions: { [TASKS_EXTENSION_ID]: {} },
};

const envelopeSchema = z.object({
  [CLIENT_CAPABILITIES_META_KEY]: z
    .object({ extensions: z.record(z.string(), z.unknown()).optional() })
    .optional(),
});

/**
 * True when the request's per-request capabilities declare the extension.
 * A server must never answer a request with a task otherwise.
 */
export function declaresTasks(envelope: unknown): boolean {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) return false;
  const extensions = parsed.data[CLIENT_CAPABILITIES_META_KEY]?.extensions;
  return extensions !== undefined && TASKS_EXTENSION_ID in extensions;
}

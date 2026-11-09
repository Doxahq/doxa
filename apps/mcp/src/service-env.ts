import type { GenerateJobMessage } from "@doxahq/contracts";
import type { Env } from "@doxahq/api/env";
import type { McpEnv } from "./mcp-env";
import { createRemoteImageCompressor } from "./services/remote-image-compressor";

const NO_QUEUE_MESSAGE =
  "The MCP Worker has no generation queue. Generation actions run in doxa-api.";

/**
 * The API services take the full API `Env`. The MCP Worker builds one from its
 * own bindings: auth secrets stay empty and the queue refuses every call, so
 * a read path that reached for them would fail loudly instead of acting.
 */
export function toServiceEnv(env: McpEnv): Env {
  return {
    BETTER_AUTH_SECRET: "",
    BETTER_AUTH_URL: env.OAUTH_ISSUER,
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    HYPERDRIVE: env.HYPERDRIVE,
    HYPERDRIVE_CACHE_DISABLED: env.HYPERDRIVE_CACHE_DISABLED,
    DATABASE_URL: env.DATABASE_URL,
    DOCS_BUCKET: env.DOCS_BUCKET,
    GENERATION_QUEUE: unavailableQueue,
    ...(env.PLATFORM_ACTIONS
      ? { IMAGE_COMPRESSOR: createRemoteImageCompressor(env.PLATFORM_ACTIONS) }
      : {}),
    WEB_ORIGIN: env.WEB_ORIGIN,
    DOCS_BASE_DOMAIN: env.DOCS_BASE_DOMAIN,
    DOCS_RENDERER_BASE_URL: env.DOCS_RENDERER_BASE_URL,
    DOCS_CUSTOM_DOMAIN_CNAME_TARGET: env.DOCS_CUSTOM_DOMAIN_CNAME_TARGET,
  };
}

const unavailableQueue: Queue<GenerateJobMessage> = {
  metrics: () => Promise.reject(new Error(NO_QUEUE_MESSAGE)),
  send: () => Promise.reject(new Error(NO_QUEUE_MESSAGE)),
  sendBatch: () => Promise.reject(new Error(NO_QUEUE_MESSAGE)),
};

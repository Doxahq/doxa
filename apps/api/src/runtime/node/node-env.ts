import { Redis } from "ioredis";
import type { Env } from "../../env";
import { BridgeClient, createBridgedBindings } from "./bindings/bridge-bindings";
import { S3R2Bucket, createR2S3Client } from "./bindings/r2-s3-bucket";
import { ValkeyKvNamespace } from "./bindings/valkey-kv-namespace";
import { readApiVars, type DocsBucketSource, type NodeServerConfig } from "./config";

/** The API env on Node, and what must close at shutdown. */
export interface NodeEnv {
  env: Env;
  close(): Promise<void>;
}

/**
 * Builds the `Env` that the API code expects, with Node bindings:
 *
 *   DOCS_BUCKET         R2 over S3, or the local Wrangler state in development
 *   AUTH_KV, OAUTH_KV   Valkey
 *   queues, services    the bridge to the edge Worker
 *
 * `vars` holds the string variables, as the Worker gets them.
 */
export async function createNodeEnv(config: NodeServerConfig, vars: Record<string, unknown>): Promise<NodeEnv> {
  const valkey = new Redis(config.valkeyUrl, {
    // Fail a command after a few reconnect attempts instead of queueing it forever.
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
  });
  valkey.on("error", (cause) => {
    console.error("Valkey connection error.", cause);
  });

  const docsBucket = await openDocsBucket(config.docsBucket);
  const bridge = new BridgeClient(config.bridge);

  const env: Env = {
    ...readApiVars(vars),
    DOCS_BUCKET: docsBucket.bucket,
    AUTH_KV: new ValkeyKvNamespace(valkey, "auth"),
    OAUTH_KV: new ValkeyKvNamespace(valkey, "oauth"),
    ...createBridgedBindings(bridge),
  };

  return {
    env,
    async close() {
      await Promise.allSettled([valkey.quit(), docsBucket.close()]);
    },
  };
}

interface OpenBucket {
  bucket: R2Bucket;
  close(): Promise<void>;
}

async function openDocsBucket(source: DocsBucketSource): Promise<OpenBucket> {
  if (source.kind === "s3") {
    const client = createR2S3Client(source);
    return {
      bucket: new S3R2Bucket(client, source.bucket),
      close: async () => client.destroy(),
    };
  }

  // Development only: the same local R2 state that the dev Workers use.
  // Wrangler is a dev dependency, left out of the production bundle.
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy<{ DOCS_BUCKET: R2Bucket }>({
    configPath: source.wranglerConfigPath,
    persist: { path: source.persistPath },
  });
  return { bucket: proxy.env.DOCS_BUCKET, close: () => proxy.dispose() };
}

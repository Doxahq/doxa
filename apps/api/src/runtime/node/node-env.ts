import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import type { Env } from "../../env";
import { BridgeClient, createBridgedBindings } from "./bindings/bridge-bindings";
import { S3R2Bucket, createR2S3Client } from "./bindings/r2-s3-bucket";
import { ValkeyKvNamespace } from "./bindings/valkey-kv-namespace";
import { createValkeyCronLock } from "./cron-lease";
import type { WithCronLock } from "./cron";
import { ProcessImageWorker } from "./image-processing/process-image-worker";
import { modelTokenBrokerFromVars } from "./model-access/model-token-broker-from-vars";
import { billingConfigFor } from "../../services/billing/config";
import { createNodeBillingPayments } from "./billing";
import { createNodeProductAnalytics } from "./product-analytics";
import { readApiVars, type DocsBucketSource, type NodeServerConfig } from "./config";

/** The API env on Node, and what must close at shutdown. */
export interface NodeEnv {
  env: Env;
  /** The cron lock, a lease in the same Valkey. */
  cronLock: WithCronLock;
  close(): Promise<void>;
}

/**
 * Builds the `Env` that the API code expects, with Node bindings:
 *
 *   DOCS_BUCKET         R2 over S3, or the local Wrangler state in development
 *   AUTH_KV, OAUTH_KV   Valkey
 *   queues, services    the bridge to the edge Worker
 *   MODEL_TOKEN_BROKER  Anthropic tokens from the task role, when federation is set up
 *   IMAGE_COMPRESSOR    sharp, in child processes
 *   SVG_CLEANER         the SVG cleaning, in the same child processes
 *   BILLING_PAYMENTS    Checkout, Portal, invoices, webhooks and billing jobs
 *   PRODUCT_ANALYTICS   PostHog, when POSTHOG_KEY is set
 *
 * `vars` holds the string variables, as the Worker gets them.
 */
export async function createNodeEnv(config: NodeServerConfig, vars: Record<string, unknown>): Promise<NodeEnv> {
  const apiVars = readApiVars(vars);
  // Billing spec 6.3: read once at start-up; a wrong value or a missing
  // provider secret fails start-up with BillingConfigurationError.
  const billingPayments = createNodeBillingPayments({ config: billingConfigFor(apiVars) });
  const productAnalytics = createNodeProductAnalytics(apiVars);
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
  const modelTokenBroker = modelTokenBrokerFromVars(vars);
  const imageWorker = new ProcessImageWorker({
    // The build writes this file next to server.mjs.
    childPath: fileURLToPath(new URL("./image-worker-child.mjs", import.meta.url)),
  });

  const env: Env = {
    ...apiVars,
    BILLING_PAYMENTS: billingPayments,
    ...(productAnalytics.binding ? { PRODUCT_ANALYTICS: productAnalytics.binding } : {}),
    DOCS_BUCKET: docsBucket.bucket,
    AUTH_KV: new ValkeyKvNamespace(valkey, "auth"),
    OAUTH_KV: new ValkeyKvNamespace(valkey, "oauth"),
    ...createBridgedBindings(bridge),
    IMAGE_COMPRESSOR: imageWorker,
    SVG_CLEANER: imageWorker,
    ...(modelTokenBroker ? { MODEL_TOKEN_BROKER: modelTokenBroker } : {}),
  };

  return {
    env,
    cronLock: createValkeyCronLock(valkey),
    async close() {
      await Promise.allSettled([valkey.quit(), docsBucket.close(), productAnalytics.close()]);
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

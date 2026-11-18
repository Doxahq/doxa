import { createServer } from "node:http";
import { serve, type ServerType } from "@hono/node-server";
import { createSharedPgPoolProvider, usePgPoolProvider } from "@doxahq/db";
import { createApiRequestHandler } from "../../app";
import { BackgroundTasks } from "./background-tasks";
import { readServerConfig, type NodeServerConfig } from "./config";
import { createCronHandler } from "./cron";
import { createNodeEnv } from "./node-env";
import { createOriginHandler } from "./origin-handler";
import { createRpcHandler } from "./rpc-handler";
import { assertStrictPublicFetch } from "./strict-public-fetch";

/** The edge reuses origin connections, so keep idle ones longer than the tunnel does. */
const KEEP_ALIVE_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 125_000;

/**
 * The API as a long-running Node server: the origin behind the thin
 * doxa-api Worker. It serves the public API, the RPC calls and the cron
 * tick on one port, with one Postgres pool for the process.
 */
export async function startServer(source: Record<string, string | undefined> = process.env): Promise<void> {
  const config = readServerConfig(source);
  if (config.strictPublicFetch) await assertStrictPublicFetch();
  const pools = createSharedPgPoolProvider({ max: config.pgPoolMax });
  usePgPoolProvider(pools);

  const nodeEnv = await createNodeEnv(config, await readVars(config, source));
  const tasks = new BackgroundTasks();
  const createExecutionContext = () => tasks.createExecutionContext();

  const handle = createOriginHandler({
    env: nodeEnv.env,
    originKey: config.originKey,
    api: createApiRequestHandler(),
    rpc: createRpcHandler({ env: nodeEnv.env, originKey: config.originKey, createExecutionContext }),
    cron: createCronHandler({ env: nodeEnv.env, originKey: config.originKey, tasks, withLock: nodeEnv.cronLock }),
    createExecutionContext,
  });

  const server = serve(
    {
      fetch: handle,
      port: config.port,
      hostname: config.host,
      createServer,
      serverOptions: { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS },
    },
    (info) => {
      console.info(`doxa-api origin listening on ${config.host}:${info.port}`);
    },
  );

  onShutdownSignal(async () => {
    console.info("Shutting down: no new requests, finishing open work.");
    await closeServer(server, config.shutdownGraceMs);
    const drained = await tasks.drain(config.shutdownGraceMs);
    if (!drained) console.warn(`${tasks.size} background tasks were still running at shutdown.`);
    await nodeEnv.close();
    await pools.close();
  });
}

/**
 * The string variables of the API. In production they are the process env.
 * With the local docs bucket, the Wrangler config and `.dev.vars` fill in
 * what the process env does not set, as `wrangler dev` does.
 */
async function readVars(config: NodeServerConfig, source: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  if (config.docsBucket.kind !== "local") return source;
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy({ configPath: config.docsBucket.wranglerConfigPath, persist: false });
  const vars = { ...proxy.env, ...source };
  await proxy.dispose();
  return vars;
}

/** Stops accepting connections and waits for open requests, up to the grace time. */
function closeServer(server: ServerType, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      resolve();
    }, graceMs);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  });
}

/** Runs `shutdown` once on SIGTERM (ECS stop) or SIGINT (Ctrl-C), then exits. */
function onShutdownSignal(shutdown: () => Promise<void>): void {
  let started = false;
  const handler = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    console.info(`Received ${signal}.`);
    shutdown().then(
      () => process.exit(0),
      (cause: unknown) => {
        console.error("Shutdown failed.", cause);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

// Local development only. `pnpm dev` runs this file on 127.0.0.1:8792, and no
// deploy script uses it. It stands in for the dispatcher, which `pnpm dev` does
// not run: the Vite renderer forwards `/__doxa/try*` here. It uses the real
// route and the real send code, in workerd, with the limits of wrangler.json.
import {
  handleDocsTryRequest,
  isDocsTryRequest,
} from "../../docs-dispatcher/src/try-route";

import type { TryProxyEnv } from "../src/env";
import { readTryConfig, sendTryRequest } from "../src/send";

export { TryBudget } from "../src/budget";

const DEV_HOST_HEADER = "x-doxa-dev-host";

interface DevGatewayEnv extends TryProxyEnv {
  DOCS_CONTENT_TOKEN: string;
  DOXA_DOCS_CONTENT_WORKER_URL: string;
}

/** Reads one runtime operation for a docs host, as the local renderer does. */
async function readRuntime(env: DevGatewayEnv, hostname: string, operation: string) {
  const response = await fetch(`${env.DOXA_DOCS_CONTENT_WORKER_URL}/runtime-source`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.DOCS_CONTENT_TOKEN}`,
      "content-type": "application/json",
      "x-doxa-runtime-source-version": "1",
      "x-doxa-host": hostname,
    },
    body: JSON.stringify({ operation }),
  });
  if (!response.ok) return { ok: false as const, error: { code: "unavailable", message: `${response.status}` } };
  return (await response.json()) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
}

export default {
  async fetch(request: Request, env: DevGatewayEnv): Promise<Response> {
    const host = request.headers.get(DEV_HOST_HEADER);
    if (!host) return new Response(null, { status: 404 });
    const { pathname, search } = new URL(request.url);
    const site = new Request(`http://${host}${pathname}${search}`, request);
    if (!isDocsTryRequest(site)) return new Response(null, { status: 404 });

    const hostname = new URL(site.url).hostname;
    return handleDocsTryRequest(site, {
      // Local sites are public production sites. The limits count per host.
      resolveHost: async () =>
        ({ hostname, siteId: hostname, accessPolicy: "public", renderTarget: "production" }) as never,
      runtime: {
        request: async () => (await readRuntime(env, host, "getFeatureConfig")) as never,
      },
      proxy: {
        config: async (context) => readTryConfig(env, context),
        send: async (body, context) => sendTryRequest({ env, body, context }),
      },
    });
  },
};

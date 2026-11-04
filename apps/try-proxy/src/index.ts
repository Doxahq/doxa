import type {
  DocsTryConfig,
  DocsTryContext,
  DocsTryProxyRpc,
} from "@doxahq/contracts/docs-try";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { TryProxyEnv } from "./env";
import { readTryConfig, sendTryRequest } from "./send";

export { TryBudget } from "./budget";

/**
 * The only code that sends a playground request to a customer API.
 *
 * It has no public route, no secrets and no binding to the Doxa API or to a
 * private network. A bug here can reach only what any public client can reach.
 * The API on ECS must never make these calls, because its metadata address
 * returns the credentials of the task role.
 */
export class TryProxyApi
  extends WorkerEntrypoint<TryProxyEnv>
  implements DocsTryProxyRpc
{
  async config(context: DocsTryContext): Promise<DocsTryConfig> {
    return readTryConfig(this.env, context);
  }

  async send(
    body: ReadableStream<Uint8Array> | null,
    context: DocsTryContext,
  ): Promise<Response> {
    return sendTryRequest({ env: this.env, body, context });
  }
}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler<TryProxyEnv>;

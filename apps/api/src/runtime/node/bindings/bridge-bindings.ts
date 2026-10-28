import {
  BRIDGE_KEY_HEADER,
  FORWARD_URL_HEADER,
  bridgeCallPath,
  bridgeFetchPath,
  callRemote,
  type BridgeCallBindingName,
  type BridgeCallMethod,
  type BridgeFetchBindingName,
} from "@doxahq/api-bridge";
import type { DocsCacheInvalidationRpc, GenerateJobMessage } from "@doxahq/contracts";
import type { PrerenderQueueRpc } from "@doxahq/contracts/docs-prerender-tasks";
import type { EmailQueueMessage } from "@doxahq/email";
import type { AgentContainerBinding } from "@doxahq/generation";

export interface BridgeClientConfig {
  /** Base URL of the edge Worker, for example https://api.doxa.so. */
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
}

/**
 * Calls Cloudflare bindings that only the edge Worker has: Queues, the
 * renderer cache, the prerender queue and the agent container. The edge
 * serves these calls at `/__bridge/*` and checks the bridge key.
 */
export class BridgeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: BridgeClientConfig) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * Calls `method` on `binding` at the edge. The edge runs the binding of the
   * same interface, so the result has the type that the interface declares.
   */
  call<Result, B extends BridgeCallBindingName>(binding: B, method: BridgeCallMethod<B>, args: readonly unknown[]): Promise<Result>;
  call(binding: BridgeCallBindingName, method: string, args: readonly unknown[]): Promise<unknown> {
    return callRemote(
      {
        fetch: (request) => this.fetchImpl(request),
        url: new URL(bridgeCallPath(binding, method), this.config.baseUrl).toString(),
        keyHeader: BRIDGE_KEY_HEADER,
        key: this.config.key,
      },
      args,
    );
  }

  /** Sends `request` to a fetch binding at the edge, with its method, headers and body. */
  async fetchBinding(binding: BridgeFetchBindingName, request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set(BRIDGE_KEY_HEADER, this.config.key);
    headers.set(FORWARD_URL_HEADER, request.url);
    const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
    return this.fetchImpl(new URL(bridgeFetchPath(binding), this.config.baseUrl), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      signal: request.signal,
      // Pass a redirect back unchanged. Following it would send the bridge key along.
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    });
  }
}

/** A Queue producer whose sends go through the edge. */
type QueueBindingName = "GENERATION_QUEUE" | "EMAIL_QUEUE";

export class BridgedQueue<Body> implements Queue<Body> {
  constructor(
    private readonly bridge: BridgeClient,
    private readonly binding: QueueBindingName,
  ) {}

  send(message: Body, options?: QueueSendOptions): Promise<QueueSendResponse> {
    return this.bridge.call<QueueSendResponse, QueueBindingName>(this.binding, "send", [message, options]);
  }

  sendBatch(messages: Iterable<MessageSendRequest<Body>>, options?: QueueSendBatchOptions): Promise<QueueSendBatchResponse> {
    return this.bridge.call<QueueSendBatchResponse, QueueBindingName>(this.binding, "sendBatch", [[...messages], options]);
  }

  metrics(): Promise<QueueMetrics> {
    return Promise.reject(new Error(`Queue metrics are not available through the bridge (${this.binding}).`));
  }
}

export interface BridgedBindings {
  GENERATION_QUEUE: Queue<GenerateJobMessage>;
  EMAIL_QUEUE: Queue<EmailQueueMessage>;
  DOCS_CACHE_INVALIDATOR: DocsCacheInvalidationRpc;
  PRERENDER_QUEUE: PrerenderQueueRpc;
  AGENT_CONTAINER: AgentContainerBinding;
}

/** Every binding that the Node server reaches through the edge Worker. */
export function createBridgedBindings(bridge: BridgeClient): BridgedBindings {
  return {
    GENERATION_QUEUE: new BridgedQueue<GenerateJobMessage>(bridge, "GENERATION_QUEUE"),
    EMAIL_QUEUE: new BridgedQueue<EmailQueueMessage>(bridge, "EMAIL_QUEUE"),
    DOCS_CACHE_INVALIDATOR: {
      invalidate: (input) => bridge.call<void, "DOCS_CACHE_INVALIDATOR">("DOCS_CACHE_INVALIDATOR", "invalidate", [input]),
      syncHostnames: (input) => bridge.call<void, "DOCS_CACHE_INVALIDATOR">("DOCS_CACHE_INVALIDATOR", "syncHostnames", [input]),
    },
    PRERENDER_QUEUE: {
      start: (input) => bridge.call("PRERENDER_QUEUE", "start", [input]),
      inspect: (input) => bridge.call("PRERENDER_QUEUE", "inspect", [input]),
      collectRender: (input) => bridge.call("PRERENDER_QUEUE", "collectRender", [input]),
    },
    AGENT_CONTAINER: {
      fetch: (request) => bridge.fetchBinding("AGENT_CONTAINER", request),
    },
  };
}

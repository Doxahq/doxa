import type { DocsRuntimeExports } from "../../src/worker-exports";

/** The `ctx` of one request, with the given loopback bindings. */
export function testExecutionContext(
  exports: DocsRuntimeExports = {},
): ExecutionContext {
  return {
    waitUntil: (promise) => void promise.catch(() => undefined),
    passThroughOnException: () => undefined,
    props: {},
    exports,
  };
}

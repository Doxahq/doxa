/**
 * `cloudflare:workers` exists only in workerd. Tests load this stand-in, and a
 * test can still replace it with `vi.mock("cloudflare:workers", ...)`.
 */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: ExecutionContext,
    protected readonly env: Env,
  ) {}
}

/** Outside workerd there is no request to keep alive. */
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

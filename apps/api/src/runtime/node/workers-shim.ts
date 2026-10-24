/**
 * `cloudflare:workers` in the Node build: the build aliases the module to
 * this file. The RPC route constructs an entrypoint class with an execution
 * context and the env, as workerd does, and calls one method on it.
 *
 * `@cloudflare/workers-oauth-provider` checks `prototype instanceof
 * WorkerEntrypoint`. It imports the same aliased module, so the check works.
 */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

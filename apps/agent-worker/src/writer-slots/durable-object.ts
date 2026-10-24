import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import { parseAccountWriterSlots } from "./config";
import type { WriterSlotLease } from "./limiter";
import { WriterSlotsService } from "./service";

/**
 * The one account-wide writer slot pool. Callers use one named instance
 * through Workers RPC; see `createDurableObjectWriterSlotLimiter`.
 */
export class WriterSlotsDurableObject extends DurableObject<Env> {
  private readonly service: Promise<WriterSlotsService>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = WriterSlotsService.load(ctx.storage, {
      ceiling: parseAccountWriterSlots(env.DOXA_ACCOUNT_WRITER_SLOTS),
    });
    // No request runs before the stored leases are loaded. A failed load
    // resets the object, so the next request loads again.
    void ctx.blockConcurrencyWhile(async () => {
      await this.service;
    });
  }

  async acquire(request: unknown): Promise<WriterSlotLease> {
    return (await this.service).acquire(request);
  }

  async release(request: unknown): Promise<void> {
    return (await this.service).release(request);
  }

  async renew(request: unknown): Promise<WriterSlotLease | null> {
    return (await this.service).renew(request);
  }
}

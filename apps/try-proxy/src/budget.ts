import { DurableObject } from "cloudflare:workers";

interface Usage {
  day: string;
  used: number;
}

/**
 * One count per UTC day, for one site or one target host.
 *
 * The rate limit bindings count per Cloudflare location, so traffic that is
 * spread over many locations gets more than their numbers. This is the only
 * limit that holds across all locations.
 */
export class TryBudget extends DurableObject {
  async take(limit: number, day: string): Promise<boolean> {
    const current = await this.ctx.storage.get<Usage>("usage");
    const used = current?.day === day ? current.used : 0;
    if (used >= limit) return false;
    await this.ctx.storage.put<Usage>("usage", { day, used: used + 1 });
    return true;
  }
}

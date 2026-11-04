import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { placeAnchor, readAnchorColo } from "./warm-anchor";
import type { AnchorStartResult, WarmAnchorRpc, WarmEnv } from "./warm-env";
import { regionalWarmerName, warmJobSchema } from "./warm-job";
import { logWarm } from "./warm-log";

/**
 * A pool's anchor (`idFromName("anchor:" + pool)`, created with the pool's
 * location hint). It checks its own colo and creates the site's regional
 * warmer, which then lands in the same pool. It never fills a cache.
 */
export class DocsWarmAnchor extends DurableObject<WarmEnv> implements WarmAnchorRpc {
  async start(input: unknown): Promise<AnchorStartResult> {
    const { job } = z.object({ job: warmJobSchema }).parse(input);
    const colo = await readAnchorColo({
      storage: this.ctx.storage,
      baseDomain: this.env.DOXA_DOCS_BASE_DOMAIN,
      fetchText: async (url) => (await fetch(url)).text(),
    });
    const placement = placeAnchor(job.pool, colo);
    logWarm("docs_warm_anchor", {
      pool: job.pool,
      colo,
      placement,
      misplaced: placement === "misplaced",
      jobId: job.jobId,
      siteId: job.siteId,
    });
    if (placement === "misplaced" && colo) return { status: "misplaced", colo };
    const warmers = this.env.DOCS_REGIONAL_WARMER;
    if (!warmers) throw new Error("DOCS_REGIONAL_WARMER is not bound");
    // No location hint: the warmer is created next to its first caller.
    const warmer = warmers.get(warmers.idFromName(regionalWarmerName(job.pool, job.siteId)));
    await warmer.start({ job });
    return { status: "started", colo };
  }
}

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { lookupHostnameMapEntry } from "../hostname-map";
import { hasPrerenderManifest } from "../prerender-storage";
import { getWorkerExports } from "../worker-exports";
import { readWarmConfig } from "./warm-config";
import type { RegionalWarmerRpc, WarmEnv } from "./warm-env";
import {
  fillCacheCall,
  isCacheCallStored,
  selectWarmCalls,
} from "./warm-fill";
import { WARM_SLOTS_NAME, siteLockName, warmJobSchema, type WarmJob } from "./warm-job";
import { logWarm } from "./warm-log";
import { findSupersedeReason } from "./warm-supersede";
import { runWarmerAlarm, startWarmer, type WarmerDeps } from "./warm-warmer";

/**
 * One per pool and site (`idFromName("warm:" + pool + ":" + siteId)`),
 * created by the pool's anchor, so it runs in that pool. Its alarms fill the
 * site's keys through `ctx.exports` only (F34); see warm-warmer.ts.
 */
export class DocsRegionalWarmer extends DurableObject<WarmEnv> implements RegionalWarmerRpc {
  async start(input: unknown): Promise<void> {
    const { job } = z.object({ job: warmJobSchema }).parse(input);
    await startWarmer(this.ctx.storage, job, Date.now());
  }

  async alarm(): Promise<void> {
    await runWarmerAlarm(this.createDeps());
  }

  private createDeps(): WarmerDeps {
    const env = this.env;
    const config = readWarmConfig(env);
    const exports = getWorkerExports(this.ctx);
    const control = env.DOCS_WARM_CONTROL;
    const locks = env.DOCS_WARM_LOCK;
    if (!control || !locks) throw new Error("The warm Durable Object bindings are missing");
    const slots = control.get(control.idFromName(WARM_SLOTS_NAME));
    const lockOf = (job: WarmJob) => locks.get(locks.idFromName(siteLockName(job.siteId)));
    const readEntry = (hostname: string) =>
      lookupHostnameMapEntry(env.DOCS_HOSTNAME_MAP, hostname, Date.now());
    return {
      storage: this.ctx.storage,
      now: () => Date.now(),
      holder: this.ctx.id.toString(),
      slots: {
        acquire: (holder, siteId) =>
          slots.acquireSlot({
            holder,
            siteId,
            max: config.maxActiveWarmers,
            maxPerSite: config.maxActiveWarmersPerSite,
          }),
        release: (holder) => slots.releaseSlot({ holder }),
      },
      lock: {
        report: (job, report) =>
          lockOf(job).report({ siteId: job.siteId, jobId: job.jobId, pool: job.pool, report }),
        heartbeat: async (job) =>
          (await lockOf(job).heartbeat({ siteId: job.siteId, jobId: job.jobId })).current,
        reserveFills: (job, count) =>
          lockOf(job).reserveFills({ siteId: job.siteId, jobId: job.jobId, count }),
      },
      isSuperseded: async (job) => {
        const reason = await findSupersedeReason(job, {
          config,
          deployedReleaseId: env.DOXA_RENDERER_RELEASE_ID?.trim() || null,
          readEntry,
        });
        if (reason) {
          logWarm("docs_warm_region", { jobId: job.jobId, pool: job.pool, outcome: "superseded", reason });
        }
        return reason !== null;
      },
      selectCalls: (target, pathname) => selectWarmCalls({ target, pathname, env }),
      isSavedOutputReady: async (call) => {
        if (call.entrypoint !== "DocsPrerenderCache") return true;
        const bucket = env.DOCS_RENDERED_BUCKET;
        return bucket ? hasPrerenderManifest(bucket, call.props.expected) : false;
      },
      fill: (call) => fillCacheCall(exports, call),
      probe: (call) => isCacheCallStored(exports, call),
    };
  }
}

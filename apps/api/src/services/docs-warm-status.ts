import type { DocsCacheInvalidationRpc } from "@doxahq/contracts";
import {
  docsWarmStatusSchema,
  type DocsWarmStatus,
} from "@doxahq/contracts/docs-warm-job";
import type { Env } from "../env";
import { DocsSiteIdsRepository } from "../repositories/docs-site-ids";

/** A status read must never hold the dashboard's poll. */
export const WARM_STATUS_TIMEOUT_MS = 2_000;

export interface DocsWarmStatusDeps {
  siteIdForProject(projectId: string): Promise<string | null>;
  /** The dispatcher binding; a dispatcher before M45b has no `getWarmStatus`. */
  binding: Pick<DocsCacheInvalidationRpc, "getWarmStatus"> | undefined;
  timeoutMs?: number;
}

/**
 * The regional warm progress of a project's site (M45b), or null when it is
 * unknown: no site, no binding, an old dispatcher, an error, a timeout or an
 * answer that does not match the contract. Never throws.
 */
export class DocsWarmStatusService {
  constructor(private readonly deps: DocsWarmStatusDeps) {}

  static fromEnv(env: Env): DocsWarmStatusService {
    const sites = new DocsSiteIdsRepository(env);
    return new DocsWarmStatusService({
      siteIdForProject: (projectId) => sites.forProject(projectId),
      binding: env.DOCS_CACHE_INVALIDATOR,
    });
  }

  async forProject(projectId: string): Promise<DocsWarmStatus | null> {
    const binding = this.deps.binding;
    if (typeof binding?.getWarmStatus !== "function") return null;
    try {
      const siteId = await this.deps.siteIdForProject(projectId);
      if (!siteId) return null;
      const answer: unknown = await withTimeout(
        binding.getWarmStatus({ siteId }),
        this.deps.timeoutMs ?? WARM_STATUS_TIMEOUT_MS,
      );
      const parsed = docsWarmStatusSchema.safeParse(answer);
      return parsed.success && parsed.data.siteId === siteId ? parsed.data : null;
    } catch (error) {
      console.warn("Docs warm status unavailable", {
        projectId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Warm status timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

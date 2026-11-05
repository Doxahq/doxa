import {
  isRemoteSearchProvider,
  type DocsSearchProvider,
  type DocsSearchRemoteProvider,
} from "@doxahq/contracts/docs-search";
import { resolveSearchProvider } from "@doxahq/contracts/entitlements";
import { searchIndexPathForPrefix } from "@doxahq/docs-engine";
import { parseRuntimeSearchArtifact } from "@doxahq/docs-search";
import type { SearchIndexFacts } from "@doxahq/docs-search/providers";
import { searchProviderChoiceSchema } from "@doxahq/site-config";
import { z } from "zod";

import { abortable } from "./abortable";
import { DOCS_SEARCH_TASK_BUDGET_MS } from "./limits";
import type { DocsSearchWriters } from "./providers";
import type { SearchPolicyService } from "./policy";

/** A claimed task: everything comes from the database, never from a request. */
export interface ClaimedDocsSearchTask {
  id: string;
  siteId: string;
  versionId: string;
  projectId: string;
  artifactPrefix: string;
  attempts: number;
  claimToken: string;
}

/** A live version that the scheduler compares with its wanted provider. */
export interface DocsSearchRecheck {
  id: string;
  siteId: string;
  versionId: string;
  projectId: string;
  artifactPrefix: string;
  status: string;
  provider: string | null;
  indexKey: string | null;
  siteProvider: string;
  siteIndexKey: string | null;
}

export interface DocsSearchTaskStore {
  claimNext(ids?: readonly string[]): Promise<ClaimedDocsSearchTask | null>;
  /** The index to write, or null if the worker must not write. */
  beginWrite(
    task: ClaimedDocsSearchTask,
    provider: DocsSearchRemoteProvider,
  ): Promise<string | null>;
  complete(
    task: ClaimedDocsSearchTask,
    outcome: { provider: DocsSearchProvider; facts: SearchIndexFacts | null },
  ): Promise<void>;
  fail(task: ClaimedDocsSearchTask, error: string): Promise<void>;
  listRechecks(): Promise<DocsSearchRecheck[]>;
  markRechecked(id: string): Promise<void>;
  reopen(id: string): Promise<void>;
}

export interface DocsSearchIndexWorkerDeps {
  tasks: DocsSearchTaskStore;
  policy: SearchPolicyService;
  writers: DocsSearchWriters;
  read(key: string): Promise<string | null>;
  /** False when the production site sits behind an access gate. */
  isPublic: boolean;
}

const MAX_TASKS_PER_RUN = 10;

const siteSearchChoiceSchema = z.object({
  features: z
    .object({ searchProvider: searchProviderChoiceSchema.optional() })
    .optional(),
});

/** Sends a published version's search documents to its provider. */
export class DocsSearchIndexWorker {
  constructor(private readonly deps: DocsSearchIndexWorkerDeps) {}

  /**
   * Runs due tasks one at a time, inside the budget. A stalled provider or a
   * stalled read costs this run its budget, so it cannot hold the other jobs.
   */
  async run(
    ids?: readonly string[],
    signal: AbortSignal = AbortSignal.timeout(DOCS_SEARCH_TASK_BUDGET_MS),
  ): Promise<{ processed: number }> {
    let processed = 0;
    while (processed < MAX_TASKS_PER_RUN && !signal.aborted) {
      const task = await this.deps.tasks.claimNext(ids);
      if (!task) break;
      await this.process(task, signal);
      processed += 1;
    }
    return { processed };
  }

  /**
   * Compares live versions with the provider they should use now, so a plan
   * change, a new credential or a lost index repairs itself. A row that cannot
   * be checked goes to the back of the line, so one bad row cannot hold the
   * others.
   */
  async reconcile(signal: AbortSignal): Promise<{ reopened: number }> {
    let reopened = 0;
    for (const row of await this.deps.tasks.listRechecks()) {
      if (signal.aborted) break;
      try {
        if (await abortable(this.needsWork(row, signal), signal)) {
          await this.deps.tasks.reopen(row.id);
          reopened += 1;
          continue;
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "docs_search_recheck_failed",
            siteId: row.siteId,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
      await this.deps.tasks.markRechecked(row.id);
    }
    return { reopened };
  }

  private async needsWork(
    row: DocsSearchRecheck,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (row.status === "failed" || row.status === "superseded") return true;
    const wanted = await this.chooseProvider(row);
    if (row.provider !== wanted || row.siteProvider !== wanted) return true;
    if (!isRemoteSearchProvider(wanted)) return row.siteIndexKey !== null;
    if (!row.indexKey || row.siteIndexKey !== row.indexKey) return true;
    const writer = this.deps.writers[wanted];
    if (!writer) return false;
    return !(await writer.hasIndex(row.indexKey, signal));
  }

  private async process(
    task: ClaimedDocsSearchTask,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const provider = await abortable(this.chooseProvider(task), signal);
      if (!isRemoteSearchProvider(provider)) {
        await this.deps.tasks.complete(task, { provider, facts: null });
        return;
      }
      const indexKey = await this.deps.tasks.beginWrite(task, provider);
      if (!indexKey) return;
      const facts = await this.writeRemoteIndex(task, provider, indexKey, signal);
      await this.deps.tasks.complete(task, { provider, facts });
    } catch (error) {
      // The class name only: a provider message can repeat request data.
      const name = error instanceof Error ? error.name : "UnknownError";
      console.warn(
        JSON.stringify({
          event: "docs_search_index_failed",
          siteId: task.siteId,
          versionId: task.versionId,
          attempts: task.attempts,
          errorClass: name,
        }),
      );
      await this.deps.tasks.fail(task, name);
    }
  }

  /**
   * The setting says what the owner wants, and the plan says what is allowed.
   * Private docs never leave our storage, whatever the setting says.
   */
  private async chooseProvider(
    task: Pick<ClaimedDocsSearchTask, "projectId" | "artifactPrefix">,
  ): Promise<DocsSearchProvider> {
    if (!this.deps.isPublic) return "minisearch";
    const [policy, choice] = await Promise.all([
      this.deps.policy.getSearchPolicy(task.projectId),
      this.readChoice(task.artifactPrefix),
    ]);
    const provider = resolveSearchProvider(choice, policy);
    if (isRemoteSearchProvider(provider) && !this.deps.writers[provider]) {
      return "minisearch";
    }
    return provider;
  }

  private async readChoice(
    artifactPrefix: string,
  ): Promise<DocsSearchProvider | undefined> {
    const raw = await this.deps.read(`${artifactPrefix}/settings/site.json`);
    if (!raw) return undefined;
    try {
      const parsed = siteSearchChoiceSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.features?.searchProvider : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeRemoteIndex(
    task: ClaimedDocsSearchTask,
    provider: DocsSearchRemoteProvider,
    indexKey: string,
    signal: AbortSignal,
  ): Promise<SearchIndexFacts> {
    const writer = this.deps.writers[provider];
    if (!writer) throw new Error("Search provider is not provisioned.");
    const raw = await abortable(
      this.deps.read(searchIndexPathForPrefix(task.artifactPrefix)),
      signal,
    );
    const artifact = raw ? parseRuntimeSearchArtifact(raw) : null;
    if (!artifact) throw new Error("Search documents are not readable.");
    return writer.writeIndex({
      indexKey,
      documents: artifact.documents,
      signal,
    });
  }
}

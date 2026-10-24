import {
  compiledSearchIndexPathForPrefix,
  createRuntimeSearchDocument,
  normalizeHref,
  searchIndexPathForPrefix,
  updateRuntimeSearchDocument,
} from "@doxahq/docs-engine";
import {
  compiledSearchArtifactSchema,
  createSearchEngine,
  parseRuntimeSearchArtifact,
  type RuntimeSearchArtifact,
  type RuntimeSearchDocument,
  type RuntimeSearchResult,
  type SearchEngine,
} from "@doxahq/docs-search";
import type { DocsBranchStore } from "@doxahq/api/repositories/docs-branches";
import { BranchResolver } from "@doxahq/api/services/docs-branches/branch-resolver";
import { readFrontmatterTitle } from "@doxahq/api/services/docs-content/artifacts";
import type { DocsContentStore } from "@doxahq/api/services/docs-content/store";
import {
  scanBranchPages,
  type BranchScan,
  type BranchScanStop,
} from "./branch-search-scan";

const MAX_CACHED_ENGINES = 20;

export type SearchPageStatus = "edited" | "published";

interface BranchEngine {
  engine: SearchEngine;
  editedHrefs: ReadonlySet<string>;
  stop: BranchScanStop | null;
}

// Shared by every request in the isolate. Building an index is the costly
// part. A published version never changes, and a branch engine is keyed by
// the branch revision and the main version, so a stale entry is never read.
const sharedEngines = new Map<string, SearchEngine>();
const sharedBranchEngines = new Map<string, BranchEngine>();

export interface DocsSearchInput {
  userId: string;
  projectId: string;
  query: string;
  limit: number;
  /** A named branch ID. Omitted or "main": the live site. */
  branch?: string;
}

export type MarkedSearchResult = RuntimeSearchResult & {
  status: SearchPageStatus;
};

export interface DocsSearchOutcome {
  results: MarkedSearchResult[];
  /** Set when a branch scan stopped at a limit and left changed pages out. */
  truncated: BranchScanStop | null;
}

export interface DocsSearchReader {
  search(input: DocsSearchInput): Promise<DocsSearchOutcome>;
}

type SearchBranchStore = Pick<DocsBranchStore, "resolveForUser" | "listChanges">;

/**
 * Searches the live site through the same index files the renderer serves.
 * With a branch, it also scans the branch's changed pages (spec 6.3): they
 * join the live documents in one index, built with the live tokenizer and
 * ranking, so a branch page ranks as it would after a publish.
 */
export class DocsSearch implements DocsSearchReader {
  private readonly resolver: BranchResolver;

  constructor(
    private readonly branches: SearchBranchStore,
    private readonly store: Pick<DocsContentStore, "read">,
    private readonly engines: Map<string, SearchEngine> = sharedEngines,
    private readonly branchEngines: Map<string, BranchEngine> = sharedBranchEngines,
  ) {
    this.resolver = new BranchResolver(branches);
  }

  async search(input: DocsSearchInput): Promise<DocsSearchOutcome> {
    const context = await this.resolver.resolve({
      userId: input.userId,
      projectId: input.projectId,
      branchRef: input.branch ?? "main",
    });
    const prefix = context.main.artifactPrefix;

    if (input.branch === undefined || input.branch === "main" || !context.branch) {
      const engine = await this.liveEngineFor(prefix);
      const results = engine ? engine.search(input.query, input.limit) : [];
      return { results: mark(results, new Set()), truncated: null };
    }

    const key = `${context.branch.id}:${context.branch.revision}:${context.main.versionId}`;
    const cached = this.branchEngines.get(key);
    const branchEngine =
      cached ??
      (await this.buildBranchEngine(key, prefix, {
        userId: input.userId,
        projectId: input.projectId,
        branch: context.branch.id,
      }));
    if (!cached) remember(this.branchEngines, key, branchEngine);

    return {
      results: mark(
        branchEngine.engine.search(input.query, input.limit),
        branchEngine.editedHrefs,
      ),
      truncated: branchEngine.stop,
    };
  }

  private async buildBranchEngine(
    contentVersion: string,
    mainPrefix: string,
    branch: { userId: string; projectId: string; branch: string },
  ): Promise<BranchEngine> {
    const [changes, live] = await Promise.all([
      this.branches.listChanges(branch),
      this.readSourceArtifact(mainPrefix),
    ]);
    const scan = scanBranchPages(changes);
    const documents = mergeDocuments(live?.documents ?? [], scan);

    return {
      engine: createSearchEngine({ schemaVersion: 1, contentVersion, documents }),
      editedHrefs: new Set(scan.pages.map((page) => page.href)),
      stop: scan.stop,
    };
  }

  private async liveEngineFor(prefix: string): Promise<SearchEngine | null> {
    const artifact = await this.readArtifact(prefix);
    if (!artifact) return null;
    // The prefix scopes the key to one site version, so two sites never
    // share an engine even if their content versions collide.
    const key = `${prefix}:${artifact.contentVersion}`;
    const cached = this.engines.get(key);
    if (cached) return cached;
    const engine = createSearchEngine(artifact);
    remember(this.engines, key, engine);
    return engine;
  }

  private async readArtifact(prefix: string) {
    const compiled = await this.store.read(
      compiledSearchIndexPathForPrefix(prefix),
    );
    const parsedCompiled = compiled ? parseCompiled(compiled) : null;
    if (parsedCompiled) return parsedCompiled;
    return this.readSourceArtifact(prefix);
  }

  /** The document list; a branch merge needs it, not the compiled index. */
  private async readSourceArtifact(
    prefix: string,
  ): Promise<RuntimeSearchArtifact | null> {
    const source = await this.store.read(searchIndexPathForPrefix(prefix));
    return source ? parseRuntimeSearchArtifact(source) : null;
  }
}

/**
 * The live documents without the pages the branch changed or deleted, plus
 * one document for each scanned branch page. A page the live site already
 * has keeps its navigation fields (breadcrumb, section, icon), as a publish
 * keeps them.
 */
function mergeDocuments(
  live: readonly RuntimeSearchDocument[],
  scan: BranchScan,
): RuntimeSearchDocument[] {
  const liveByHref = new Map(
    live.map((document) => [normalizeHref(document.slug), document] as const),
  );
  const replaced = new Set([
    ...scan.hiddenHrefs,
    ...scan.pages.map((page) => page.href),
  ]);
  const kept = live.filter(
    (document) => !replaced.has(normalizeHref(document.slug)),
  );
  const scanned = scan.pages.map((page) => {
    const existing = liveByHref.get(page.href);
    const input = {
      title: readFrontmatterTitle(page.content) ?? existing?.title ?? page.href,
      route: page.href,
      content: page.content,
    };
    return existing
      ? updateRuntimeSearchDocument(existing, input)
      : createRuntimeSearchDocument(input);
  });
  return [...kept, ...scanned];
}

function mark(
  results: readonly RuntimeSearchResult[],
  editedHrefs: ReadonlySet<string>,
): MarkedSearchResult[] {
  return results.map((result) => ({
    ...result,
    status: editedHrefs.has(normalizeHref(result.slug)) ? "edited" : "published",
  }));
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= MAX_CACHED_ENGINES) return;
    cache.delete(oldest);
  }
}

function parseCompiled(raw: string) {
  try {
    const result = compiledSearchArtifactSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

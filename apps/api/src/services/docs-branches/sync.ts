import {
  branchPathSchema,
  classifyBranchPath,
  type DocsConflictDiff,
  type DocsConflict,
  type DocsSyncPreview,
  type SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import { sourcePathForHref } from "@doxahq/docs-engine";
import type { ValidationIssue } from "@doxahq/site-config";
import type {
  DocsBranchStore,
  StoredBranchChange,
} from "../../repositories/docs-branches";
import { DocsContentError } from "../docs-content/errors";
import type { DocsContentStore } from "../docs-content/store";
import { isAssetPath } from "./assets/branch-assets";
import { BranchResolver, type ResolvedBranchContext } from "./branch-resolver";
import { EffectiveTree, type EffectiveTreeChange } from "./effective-tree";
import {
  computeSyncPlan,
  applyResolutions,
  type ComparedChange,
  type SyncPlan,
} from "./sync-plan";
import { mapWithConcurrency } from "../../utils/concurrency";
import { validateTree } from "./validate-tree";
import { prepareWorkingChanges } from "./working-changes";

const READ_CONCURRENCY = 16;

interface SyncState {
  context: ResolvedBranchContext;
  changes: StoredBranchChange[];
  compared: ComparedChange[];
  plan: SyncPlan;
  structurePaths: Set<string>;
}

export class SyncValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super("The synchronized documentation has validation errors.");
  }
}

export class DocsBranchSync {
  private readonly resolver: BranchResolver;

  constructor(
    private readonly branches: Pick<
      DocsBranchStore,
      "resolveForUser" | "listChanges" | "synchronize"
    >,
    private readonly store: DocsContentStore,
  ) {
    this.resolver = new BranchResolver(branches);
  }

  async preview(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<DocsSyncPreview> {
    const state = await this.load(input);

    return {
      mainVersionId: state.context.main.versionId,
      behind:
        state.context.branch?.baseVersionId !== state.context.main.versionId,
      conflicts: state.plan.conflicts,
      autoResolvedCount: state.plan.autoResolvedCount,
    };
  }

  async synchronize(input: {
    userId: string;
    projectId: string;
    branch: string;
    request: SyncDocsBranchInput;
  }): Promise<{ revision: number; changeCount: number }> {
    const state = await this.load(input);
    const { context, changes, compared, plan } = state;

    if (!context.branch) {
      throw new DocsContentError("no_changes", "This branch has no changes.");
    }

    if (context.main.versionId !== input.request.expectedMainVersionId) {
      throw new DocsContentError(
        "main_changed",
        "Main changed. Load the synchronization plan again.",
        { mainVersionId: context.main.versionId },
      );
    }

    const oldTree = new EffectiveTree(this.store, context.basePrefix, changes);
    const structureContents = new Map<string, string | null>();

    if (plan.conflicts.some(({ key }) => key === "structure")) {
      const paths = [...state.structurePaths];
      const contents = await Promise.all(
        paths.map((path) => oldTree.read(path)),
      );
      paths.forEach((path, index) =>
        structureContents.set(path, contents[index]),
      );
    }

    const result = applyResolutions({
      plan,
      changes: compared,
      request: input.request,
      structureContents,
    });

    if (result.unresolved.length) {
      throw new DocsContentError(
        "conflicts_unresolved",
        "Resolve every conflict before synchronization.",
        { conflicts: result.unresolved },
      );
    }

    if (result.structureResolution === "mine") {
      await keepPagesOfBranchStructure({
        store: this.store,
        mainPrefix: context.main.artifactPrefix,
        branchTree: oldTree,
        changedPaths: new Set(changes.map(({ path }) => path)),
        desired: result.desired,
      });
    }

    const writes = (
      await prepareWorkingChanges({
        store: this.store,
        basePrefix: context.main.artifactPrefix,
        existing: [],
        desired: result.desired,
      })
    ).filter((write) => write.kind !== "reset");
    const treeChanges: EffectiveTreeChange[] = writes.map((write) =>
      write.kind === "upsert"
        ? { path: write.path, kind: "upsert", content: write.content }
        : { path: write.path, kind: "delete", content: null },
    );

    const issues = await validateTree(
      new EffectiveTree(this.store, context.main.artifactPrefix, treeChanges),
    );

    if (issues.some(({ severity }) => severity === "error")) {
      throw new SyncValidationError(issues);
    }

    const outcome = await this.branches.synchronize({
      userId: input.userId,
      projectId: input.projectId,
      branchId: context.branch.id,
      expectedRevision: context.branch.revision,
      expectedBaseVersionId: context.branch.baseVersionId,
      expectedMainVersionId: input.request.expectedMainVersionId,
      changes: writes,
    });

    if (outcome === "not_found") {
      throw new DocsContentError("branch_not_found", "Branch not found.");
    }

    if (outcome === "main_changed") {
      const current = await this.resolver.resolve({
        userId: input.userId,
        projectId: input.projectId,
        branchRef: input.branch,
      });
      throw new DocsContentError(
        "main_changed",
        "Main changed. Load the synchronization plan again.",
        { mainVersionId: current.main.versionId },
      );
    }

    if (outcome === "revision_changed") {
      throw new DocsContentError(
        "conflict",
        "The branch changed. Load the synchronization plan again.",
      );
    }

    return {
      revision: context.branch.revision + 1,
      changeCount: writes.length,
    };
  }

  async diff(input: {
    userId: string;
    projectId: string;
    branch: string;
    key: DocsConflict["key"];
  }): Promise<DocsConflictDiff> {
    const state = await this.load(input);

    if (!state.plan.conflicts.some(({ key }) => key === input.key)) {
      throw new DocsContentError("not_found", "Conflict not found.");
    }

    if (input.key === "structure") {
      const oldTree = new EffectiveTree(
        this.store,
        state.context.basePrefix,
        state.changes,
      );
      const baseTree = new EffectiveTree(
        this.store,
        state.context.basePrefix,
        [],
      );
      const mainTree = new EffectiveTree(
        this.store,
        state.context.main.artifactPrefix,
        [],
      );
      const [base, main, mine] = await Promise.all([
        baseTree.content(),
        mainTree.content(),
        oldTree.content(),
      ]);

      return {
        unit: "structure",
        key: "structure",
        base: summarizeStructure(base),
        main: summarizeStructure(main),
        mine: summarizeStructure(mine),
      };
    }

    const path =
      input.key === "site_settings"
        ? "settings/site.json"
        : sourcePathForHref(input.key.slice("page:".length));
    const change = state.compared.find((item) => item.path === path);

    if (!change) {
      throw new DocsContentError("not_found", "Conflict not found.");
    }

    return input.key === "site_settings"
      ? {
          unit: "site_settings",
          key: "site_settings",
          base: change.base,
          main: change.main,
          mine: change.mine,
        }
      : {
          unit: "page",
          key: input.key,
          base: change.base,
          main: change.main,
          mine: change.mine,
        };
  }

  private async load(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<SyncState> {
    const context = await this.resolver.resolve({
      userId: input.userId,
      projectId: input.projectId,
      branchRef: input.branch,
    });

    const changes = context.branch
      ? await this.branches.listChanges(input)
      : [];

    const compared = await Promise.all(
      changes.map(async (change): Promise<ComparedChange> => {
        // An image change holds a pointer, so the files on both sides are
        // not compared: the branch image is kept (see computeSyncPlan).
        const [base, main] = isAssetPath(change.path)
          ? [null, null]
          : await Promise.all([
              this.store.read(`${context.basePrefix}/${change.path}`),
              this.store.read(`${context.main.artifactPrefix}/${change.path}`),
            ]);
        const mine = change.kind === "upsert" ? change.content : null;
        return {
          path: change.path,
          base,
          main,
          mine,
          baseSha256: await hash(base),
          mainSha256: await hash(main),
          mineSha256: change.kind === "upsert" ? change.contentSha256 : null,
        };
      }),
    );

    const structurePaths = await readStructurePaths(
      this.store,
      context.basePrefix,
      context.main.artifactPrefix,
      changes,
    );
    const mainChangedStructurePaths = new Set<string>();

    await Promise.all(
      [...structurePaths].map(async (path) => {
        const [base, main] = await Promise.all([
          this.store.read(`${context.basePrefix}/${path}`),
          this.store.read(`${context.main.artifactPrefix}/${path}`),
        ]);

        if ((await hash(base)) !== (await hash(main))) {
          mainChangedStructurePaths.add(path);
        }
      }),
    );

    return {
      context,
      changes,
      compared,
      structurePaths,
      plan: computeSyncPlan({ changes: compared, mainChangedStructurePaths }),
    };
  }
}

/**
 * When the branch wins the structure, its manifest can list a page that main
 * deleted. The branch never changed that page, so it has no row. The page
 * keeps the source that the branch showed, or the manifest points to a
 * missing file.
 */
async function keepPagesOfBranchStructure(input: {
  store: DocsContentStore;
  mainPrefix: string;
  branchTree: EffectiveTree;
  changedPaths: ReadonlySet<string>;
  desired: Map<string, string | null | undefined>;
}): Promise<void> {
  const { manifest } = await input.branchTree.content();
  const paths = manifest.pages
    .map((page) => page.sourcePath || sourcePathForHref(page.href))
    .filter(
      (path) => !input.changedPaths.has(path) && !input.desired.has(path),
    );
  const mainTree = new EffectiveTree(input.store, input.mainPrefix, []);
  const kept = await mapWithConcurrency(
    paths,
    READ_CONCURRENCY,
    async (path) =>
      (await mainTree.exists(path)) ? null : input.branchTree.read(path),
  );

  paths.forEach((path, index) => {
    const content = kept[index];

    if (content !== null) {
      input.desired.set(path, content);
    }
  });
}

async function hash(content: string | null): Promise<string | null> {
  if (content === null) {
    return null;
  }

  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readStructurePaths(
  store: DocsContentStore,
  basePrefix: string,
  mainPrefix: string,
  changes: readonly StoredBranchChange[],
): Promise<Set<string>> {
  const [baseKeys, mainKeys] = await Promise.all([
    store.listKeys(`${basePrefix}/`),
    store.listKeys(`${mainPrefix}/`),
  ]);
  const paths = new Set<string>(["manifest.json", "settings/sections.json"]);

  for (const [keys, prefix] of [
    [baseKeys, basePrefix],
    [mainKeys, mainPrefix],
  ]) {
    for (const key of keys) {
      const path = key.slice(prefix.length + 1);
      if (
        branchPathSchema.safeParse(path).success &&
        classifyBranchPath(path) === "structure"
      ) {
        paths.add(path);
      }
    }
  }

  for (const change of changes) {
    if (classifyBranchPath(change.path) === "structure") {
      paths.add(change.path);
    }
  }

  return paths;
}

function summarizeStructure(
  content: Awaited<ReturnType<EffectiveTree["content"]>>,
) {
  const pages = content.manifest.pages.map(({ href, title }) => ({
    href,
    title,
  }));
  const navigationTitles: string[] = [];

  for (const nodes of content.navigation.documentsBySection.values()) {
    for (const node of nodes) {
      collectTitles(node, navigationTitles);
    }
  }

  return { pages, navigationTitles };
}

function collectTitles(value: unknown, titles: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  if ("title" in value && typeof value.title === "string") {
    titles.push(value.title);
  }

  if ("items" in value && Array.isArray(value.items)) {
    for (const item of value.items) {
      collectTitles(item, titles);
    }
  }
}

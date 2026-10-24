import {
  classifyBranchPath,
  type DocsConflict,
  type SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import { readFrontmatterTitle } from "../docs-content/artifacts";
import type { DesiredChange } from "./working-changes";

export interface ComparedChange {
  path: string;
  base: string | null;
  main: string | null;
  mine: string | null;
  baseSha256?: string | null;
  mainSha256?: string | null;
  mineSha256?: string | null;
}

export type SyncDecision = "keep_change" | "drop_change" | "conflict";

export interface SyncPlan {
  decisions: ReadonlyMap<string, SyncDecision>;
  conflicts: DocsConflict[];
  autoResolvedCount: number;
}

export function computeSyncPlan(input: {
  changes: readonly ComparedChange[];
  mainChangedStructurePaths: ReadonlySet<string>;
}): SyncPlan {
  const decisions = new Map<string, SyncDecision>();
  const conflicts: DocsConflict[] = [];
  const structureChanges = input.changes.filter(
    ({ path }) => classifyBranchPath(path) === "structure",
  );

  const structurePaths = new Set(structureChanges.map(({ path }) => path));
  const structureHasIndependentChange = [
    ...input.mainChangedStructurePaths,
  ].some((path) => !structurePaths.has(path));
  const structureConflicts =
    structureChanges.length > 0 &&
    (structureHasIndependentChange ||
      structureChanges.some(
        (change) =>
          sha(change, "base") !== sha(change, "main") &&
          sha(change, "mine") !== sha(change, "main"),
      ));

  for (const change of input.changes) {
    const kind = classifyBranchPath(change.path);
    // An image has a unique name on its branch. If main got a file at the
    // same path meanwhile, the branch image wins at the next publish.
    const decision: SyncDecision =
      kind === "asset"
        ? "keep_change"
        : kind === "structure" && structureConflicts
          ? "conflict"
          : sha(change, "base") === sha(change, "main")
            ? "keep_change"
            : sha(change, "mine") === sha(change, "main")
              ? "drop_change"
              : "conflict";

    decisions.set(change.path, decision);

    if (decision !== "conflict" || kind === "structure") {
      continue;
    }

    if (kind === "site_settings") {
      conflicts.push({ unit: "site_settings", key: "site_settings" });
      continue;
    }

    const href = sourcePathToHref(change.path);

    conflicts.push({
      unit: "page",
      key: `page:${href}`,
      href,
      title:
        readFrontmatterTitle(change.mine ?? change.main ?? change.base ?? "") ??
        href,
      mine: change.mine === null ? "deleted" : "modified",
      main: change.main === null ? "deleted" : "modified",
    });
  }

  if (structureConflicts) {
    conflicts.push({ unit: "structure", key: "structure" });
  }

  return {
    decisions,
    conflicts,
    autoResolvedCount: [...decisions.values()].filter(
      (decision) => decision !== "conflict",
    ).length,
  };
}

export function applyResolutions(input: {
  plan: SyncPlan;
  changes: readonly ComparedChange[];
  request: Pick<SyncDocsBranchInput, "resolutions" | "defaultResolution">;
  structureContents: ReadonlyMap<string, string | null>;
}): {
  desired: Map<string, DesiredChange>;
  unresolved: DocsConflict[];
  /** The side that won the structure conflict, or null without one. */
  structureResolution: "mine" | "main" | null;
} {
  const resolutions = new Map(
    input.request.resolutions.map(({ key, resolution }) => [key, resolution]),
  );
  const unresolved = input.plan.conflicts.filter(
    ({ key }) => !resolutions.has(key) && !input.request.defaultResolution,
  );

  if (unresolved.length > 0) {
    return { desired: new Map(), unresolved, structureResolution: null };
  }

  const desired = new Map<string, DesiredChange>();
  const structureDecision =
    resolutions.get("structure") ?? input.request.defaultResolution;
  const structureConflict = input.plan.conflicts.some(
    ({ key }) => key === "structure",
  );
  for (const change of input.changes) {
    const kind = classifyBranchPath(change.path);

    if (kind === "structure" && structureConflict) {
      continue;
    }

    const decision = input.plan.decisions.get(change.path);

    // Deleting a page is a structure edit: the page also leaves the
    // manifest and the navigation. When main wins the structure, main still
    // lists the page, so its source must stay.
    if (
      structureConflict &&
      structureDecision === "main" &&
      kind === "page" &&
      change.mine === null &&
      change.main !== null
    ) {
      desired.set(change.path, undefined);
      continue;
    }

    if (decision === "drop_change") {
      desired.set(change.path, undefined);
    } else if (decision === "keep_change") {
      desired.set(change.path, change.mine);
    } else {
      const key =
        kind === "page"
          ? `page:${sourcePathToHref(change.path)}`
          : "site_settings";
      const resolution =
        resolutions.get(key) ?? input.request.defaultResolution;
      desired.set(change.path, resolution === "mine" ? change.mine : undefined);
    }
  }

  if (structureConflict) {
    for (const [path, content] of input.structureContents) {
      desired.set(path, structureDecision === "mine" ? content : undefined);
    }
  }

  return {
    desired,
    unresolved,
    structureResolution: structureConflict ? (structureDecision ?? null) : null,
  };
}

function sourcePathToHref(path: string): string {
  return path === "source/index.mdx"
    ? "/"
    : `/${path.slice("source/".length, -"/index.mdx".length)}`;
}

function sha(
  change: ComparedChange,
  side: "base" | "main" | "mine",
): string | null {
  return change[`${side}Sha256`] === undefined
    ? change[side]
    : (change[`${side}Sha256`] ?? null);
}

import { classifyBranchPath } from "@doxahq/contracts/docs-branches";
import {
  DOCS_WARM_HINT_PATH_LIMIT,
  docsWarmHintSchema,
  type DocsWarmHint,
} from "@doxahq/contracts/docs-warm-job";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";
import { hrefForSourcePath } from "./docs-branches/page-href";

/**
 * The warm hint of a publish (M45): ordering only. The dispatcher warms the
 * publisher's pool first and, when only pages changed, those pages first.
 * Building a hint never throws: a publish never fails over its hint.
 */

/** A changed branch file, as the branch stores it. */
export interface WarmHintChange {
  path: string;
  kind: string;
}

export interface WarmHintInput {
  /** The publisher's pool, from the request (`readClientWarmPool`). */
  region?: WarmPool | null;
  /** The branch changes that the publish makes live, when at hand. */
  changes?: readonly WarmHintChange[];
}

/** The hint, or undefined when it has nothing valid to say. */
export function buildDocsWarmHint(input: WarmHintInput): DocsWarmHint | undefined {
  try {
    const regions = input.region ? [input.region] : [];
    const paths = input.changes ? changedPagePaths(input.changes) : [];
    return validHint({
      ...(regions.length > 0 ? { regions } : {}),
      ...(paths.length > 0 ? { paths } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * The public paths of the pages that a branch adds or edits, sorted, at most
 * `DOCS_WARM_HINT_PATH_LIMIT`. None when the structure or the site settings
 * change, because then every page may render differently.
 */
export function changedPagePaths(changes: readonly WarmHintChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    const kind = classifyOrNull(change.path);
    if (kind === null || kind === "structure" || kind === "site_settings") return [];
    if (kind !== "page" || change.kind === "delete") continue;
    paths.add(hrefForSourcePath(change.path));
  }
  return [...paths].sort().slice(0, DOCS_WARM_HINT_PATH_LIMIT);
}

/** Keeps the valid parts: a bad path drops that path, never the regions. */
function validHint(hint: DocsWarmHint): DocsWarmHint | undefined {
  const paths = (hint.paths ?? []).filter(
    (path) => docsWarmHintSchema.safeParse({ paths: [path] }).success,
  );
  const candidate = {
    ...(hint.regions?.length ? { regions: hint.regions } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
  if (!candidate.regions && !candidate.paths) return undefined;
  const parsed = docsWarmHintSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const withoutPaths = docsWarmHintSchema.safeParse({ regions: candidate.regions });
  return withoutPaths.success && candidate.regions ? withoutPaths.data : undefined;
}

function classifyOrNull(path: string): ReturnType<typeof classifyBranchPath> | null {
  try {
    return classifyBranchPath(path);
  } catch {
    return null;
  }
}

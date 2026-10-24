/**
 * Groups ranked files into areas:
 * 1. A file inside a nested package root (a monorepo package) belongs to
 *    the deepest one: `packages/agent`, `apps/api`.
 * 2. Any other file belongs to its top-level directory, or to "." when it
 *    sits at the root.
 * 3. A directory area (not a package) with more than AREA_SPLIT_MIN_FILES
 *    files across several subdirectories splits one level down, so a single
 *    `src/` becomes `src/core`, `src/api`, ...
 * Areas sort by the sum of their file scores, then by path.
 */

import { appendToGroup, compareStrings } from "./collections";
import type { PackageRoot } from "./packages";
import { isWithin } from "./paths";
import type { RankedRepoMapFile, RepoMapArea } from "./types";

export const AREA_SPLIT_MIN_FILES = 40;

export function groupAreas(
  files: readonly RankedRepoMapFile[],
  packages: readonly PackageRoot[],
): RepoMapArea[] {
  const nestedPackages = packages
    .filter((root) => root.path !== ".")
    .sort((a, b) => b.path.length - a.path.length || compareStrings(a.path, b.path));
  const packageByPath = new Map(packages.map((root) => [root.path, root]));

  const groups = new Map<string, RankedRepoMapFile[]>();
  const packageAreas = new Set<string>();
  for (const file of files) {
    const root = nestedPackages.find((candidate) => isWithin(file.path, candidate.path));
    const key = root?.path ?? topDirectory(file.path);
    if (root) packageAreas.add(key);
    appendToGroup(groups, key, file);
  }

  for (const [key, members] of [...groups]) {
    if (key === "." || packageAreas.has(key) || members.length <= AREA_SPLIT_MIN_FILES) continue;
    const split = splitByChildDirectory(key, members);
    if (split.size < 2) continue;
    groups.delete(key);
    for (const [childKey, childMembers] of split) {
      for (const member of childMembers) appendToGroup(groups, childKey, member);
    }
  }

  return [...groups]
    .map(([path, members]): RepoMapArea => {
      const sortedFiles = [...members].sort((a, b) => b.score - a.score || compareStrings(a.path, b.path));
      const root = packageByPath.get(path);
      const packageName = root?.name ?? root?.goModule;
      return {
        path,
        ...(packageName ? { packageName } : {}),
        files: sortedFiles,
        score: sortedFiles.reduce((sum, file) => sum + file.score, 0),
      };
    })
    .sort((a, b) => b.score - a.score || compareStrings(a.path, b.path));
}

function topDirectory(path: string): string {
  const slash = path.indexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/** Files directly in `area` stay in it; the rest go to `area/<child>`. */
function splitByChildDirectory(
  area: string,
  members: readonly RankedRepoMapFile[],
): Map<string, RankedRepoMapFile[]> {
  const split = new Map<string, RankedRepoMapFile[]>();
  for (const file of members) {
    const rest = file.path.slice(area.length + 1);
    const slash = rest.indexOf("/");
    const key = slash < 0 ? area : `${area}/${rest.slice(0, slash)}`;
    appendToGroup(split, key, file);
  }
  return split;
}

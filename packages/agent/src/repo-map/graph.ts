/**
 * Reference graph between project files.
 * An edge A -> B means A uses B. Weights:
 * - an import that resolves to B: IMPORT_EDGE_WEIGHT;
 * - each exported name of B that A mentions: NAME_REFERENCE_WEIGHT, up to
 *   MAX_NAME_REFERENCE_WEIGHT per pair. This catches uses that imports miss
 *   (barrel re-exports, Go packages, dynamic registries).
 */

import { appendToGroup, compareStrings } from "./collections";

export const IMPORT_EDGE_WEIGHT = 1;
export const NAME_REFERENCE_WEIGHT = 0.25;
export const MAX_NAME_REFERENCE_WEIGHT = 1;
/** A name that more files define is too ambiguous to say which one is used. */
export const MAX_DEFINITIONS_PER_REFERENCED_NAME = 2;
/** Shorter exported names (`id`, `run`) match unrelated words. */
export const MIN_REFERENCED_NAME_LENGTH = 4;

export interface GraphNodeInput {
  path: string;
  dependencies: readonly string[];
  exportedNames: readonly string[];
  identifiers: ReadonlySet<string>;
}

/** Outgoing edge weights per file, keyed and iterated in sorted order. */
export type ReferenceGraph = Map<string, Map<string, number>>;

export function buildReferenceGraph(nodes: readonly GraphNodeInput[]): ReferenceGraph {
  const sorted = [...nodes].sort((a, b) => compareStrings(a.path, b.path));
  const definers = definersByName(sorted);
  const graph: ReferenceGraph = new Map();

  for (const node of sorted) {
    const weights = new Map<string, number>();
    for (const dependency of node.dependencies) {
      if (dependency !== node.path) weights.set(dependency, IMPORT_EDGE_WEIGHT);
    }
    const nameWeights = new Map<string, number>();
    for (const identifier of node.identifiers) {
      for (const definer of definers.get(identifier) ?? []) {
        if (definer === node.path) continue;
        nameWeights.set(definer, (nameWeights.get(definer) ?? 0) + NAME_REFERENCE_WEIGHT);
      }
    }
    for (const [target, weight] of nameWeights) {
      weights.set(target, (weights.get(target) ?? 0) + Math.min(weight, MAX_NAME_REFERENCE_WEIGHT));
    }
    graph.set(node.path, new Map([...weights].sort(([a], [b]) => compareStrings(a, b))));
  }
  return graph;
}

function definersByName(nodes: readonly GraphNodeInput[]): Map<string, string[]> {
  const definers = new Map<string, string[]>();
  for (const node of nodes) {
    for (const name of new Set(node.exportedNames)) {
      if (name.length < MIN_REFERENCED_NAME_LENGTH || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      appendToGroup(definers, name, node.path);
    }
  }
  for (const [name, paths] of definers) {
    if (paths.length > MAX_DEFINITIONS_PER_REFERENCED_NAME) definers.delete(name);
  }
  return definers;
}

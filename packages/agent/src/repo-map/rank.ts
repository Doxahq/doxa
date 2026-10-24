/**
 * Weighted PageRank over the reference graph. A file ranks high when many
 * files, or other high-ranking files, use it. The iteration count is fixed
 * and nodes are visited in sorted order, so equal input gives bit-equal
 * scores on every run.
 */

import { compareStrings } from "./collections";
import type { ReferenceGraph } from "./graph";

export const PAGE_RANK_DAMPING = 0.85;
/** Enough for the scores to settle to well under 1e-6 on repo-sized graphs. */
export const PAGE_RANK_ITERATIONS = 40;

export function rankFiles(graph: ReferenceGraph): Map<string, number> {
  const nodes = [...graph.keys()].sort(compareStrings);
  const count = nodes.length;
  if (count === 0) return new Map();

  const position = new Map(nodes.map((node, index) => [node, index]));
  const outgoing = nodes.map((node) => {
    const edges = [...(graph.get(node) ?? new Map<string, number>())]
      .filter(([target]) => position.has(target));
    const total = edges.reduce((sum, [, weight]) => sum + weight, 0);
    return edges.map(([target, weight]) => ({ target: position.get(target) ?? 0, share: weight / total }));
  });

  let scores = new Float64Array(count).fill(1 / count);
  for (let iteration = 0; iteration < PAGE_RANK_ITERATIONS; iteration++) {
    const next = new Float64Array(count).fill((1 - PAGE_RANK_DAMPING) / count);
    let danglingMass = 0;
    for (let index = 0; index < count; index++) {
      const edges = outgoing[index];
      if (edges.length === 0) {
        danglingMass += scores[index];
        continue;
      }
      for (const edge of edges) {
        next[edge.target] += PAGE_RANK_DAMPING * scores[index] * edge.share;
      }
    }
    // A file that uses nothing spreads its score evenly, as if it linked to every file.
    const danglingShare = (PAGE_RANK_DAMPING * danglingMass) / count;
    for (let index = 0; index < count; index++) next[index] += danglingShare;
    scores = next;
  }

  return new Map(nodes.map((node, index) => [node, scores[index]]));
}

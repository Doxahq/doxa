// The contract between the services of a release that the flip cannot make
// atomic: the API's RPC entrypoint methods (called by the other Workers) and
// the bridge methods of the edge (called by the origin). The flip serves the
// API before its callers, and old origin tasks finish their open work
// against the new edge. So for a few seconds, old code calls new code, and a
// removed method breaks those calls. Additions are safe.

import { API_ENTRYPOINT_METHODS, BRIDGE_CALL_BINDINGS, BRIDGE_FETCH_BINDINGS } from "../../../../packages/api-bridge/src/protocol.ts";

/**
 * @typedef {object} ReleaseContract
 * @property {Record<string, string[]>} entrypoints API entrypoint => methods
 * @property {Record<string, string[]>} bridgeCalls edge binding => methods the origin may call
 * @property {string[]} bridgeFetches edge bindings the origin may fetch
 */

/** The contract of this commit. @returns {ReleaseContract} */
export function currentContract() {
  return {
    entrypoints: sortedLists(API_ENTRYPOINT_METHODS),
    bridgeCalls: sortedLists(BRIDGE_CALL_BINDINGS),
    bridgeFetches: [...BRIDGE_FETCH_BINDINGS].sort(),
  };
}

/**
 * What the next release removes from the live one, as one sentence each.
 *
 * @param {ReleaseContract} live
 * @param {ReleaseContract} next
 * @returns {string[]}
 */
export function findContractBreaks(live, next) {
  return [
    ...removedMethods(live.entrypoints, next.entrypoints, "API entrypoint"),
    ...removedMethods(live.bridgeCalls, next.bridgeCalls, "edge bridge binding"),
    ...live.bridgeFetches
      .filter((binding) => !next.bridgeFetches.includes(binding))
      .map((binding) => `The edge bridge no longer fetches ${binding}.`),
  ];
}

function removedMethods(live, next, label) {
  return Object.entries(live).flatMap(([name, methods]) => {
    const nextMethods = next[name];
    if (!nextMethods) return [`The ${label} ${name} is removed.`];
    return methods.filter((method) => !nextMethods.includes(method)).map((method) => `The ${label} ${name} no longer has ${method}.`);
  });
}

/** @param {Record<string, readonly string[]>} lists */
function sortedLists(lists) {
  return Object.fromEntries(
    Object.entries(lists)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, methods]) => [name, [...methods].sort()]),
  );
}

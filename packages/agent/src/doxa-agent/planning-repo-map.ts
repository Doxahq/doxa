import type { AgentConfig, AgentProgressCallback } from "../types";
import { createNodeRepoMapSourceTree, resolveRepoMap } from "../repo-map";

/**
 * The repo map text for a full analysis, or undefined when it is turned
 * off or cannot be built. Exploration then runs without a map, as before.
 */
export async function resolvePlanningRepoMap(
  config: AgentConfig,
  onProgress?: AgentProgressCallback,
): Promise<string | undefined> {
  if (config.repoMap === false) return undefined;
  const snapshot = await resolveRepoMap(createNodeRepoMapSourceTree(config.cwd), config.repoMap ?? {});
  if (!snapshot) return undefined;
  onProgress?.({
    stage: "analyzing",
    message: `Repository map ready (${snapshot.stats.sourceFileCount} files, ${snapshot.stats.symbolCount} symbols).`,
    progress: 10,
  });
  return snapshot.text;
}

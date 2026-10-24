/**
 * Built-in tools factory.
 * Each helper returns a fresh array of {@link ToolSpec} scoped to the writer's
 * working directory.
 */

import type { ToolSpec } from "../types";
import type { AgentToolPolicy } from "../../types";
import { readTool } from "./read";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { bashTool } from "./bash";
import { validatePageTool, type ValidatePageToolOptions } from "./validate-page";

/**
 * Create all exploration tools scoped to a working directory.
 */
export function explorationTools(
  cwd: string,
  policy: AgentToolPolicy,
): ToolSpec[] {
  const tools = readOnlyTools(cwd);
  return policy === "local_shell" ? [...tools, bashTool(cwd)] : tools;
}

/**
 * Create read-only exploration tools (no Bash) scoped to a working directory.
 */
export function readOnlyTools(cwd: string): ToolSpec[] {
  return [readTool(cwd), globTool(cwd), grepTool(cwd)];
}

/**
 * Create the writer's tool bundle: read-only exploration plus the
 * `validate_page` correctness gate. The model is instructed (via the writer
 * prompt) to call `validate_page` before emitting the final draft.
 */
export function writerTools(
  cwd: string,
  validation: ValidatePageToolOptions = {},
): ToolSpec[] {
  return [...readOnlyTools(cwd), validatePageTool(validation)];
}

export { validatePageTool, VALIDATE_PAGE_TOOL_DESCRIPTION } from "./validate-page";
export type { ValidatePageToolOptions } from "./validate-page";
export {
  PROJECT_PATH_ACCESS_ERROR_CODE,
  ProjectPathAccessError,
  resolveProjectPath,
} from "./project-path";

// Tracked tools for dependency recording
export {
  createTrackedTools,
  createTrackedReadOnlyTools,
  createTrackedExplorationTools,
} from "./tracked";
export type { TrackedTools } from "./tracked";
export type { TrackedToolsOptions } from "./tracked";
export { createToolResultCache } from "./result-cache";
export type {
  ToolResultCache,
  ToolResultCacheOptions,
} from "./result-cache";

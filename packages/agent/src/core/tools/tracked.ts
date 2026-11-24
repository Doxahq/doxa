/**
 * Tracked Tool Wrappers — File Access Recording
 *
 * Wraps the read-only tools (Read, Glob, Grep) to record which source
 * files the AI agent accesses during documentation generation. This
 * enables precise per-page dependency tracking for cache invalidation.
 *
 * Usage:
 *   const { tools, getAccessedFiles } = createTrackedReadOnlyTools(cwd);
 *   // ... run the AI agent with `tools` ...
 *   const filesRead = getAccessedFiles(); // ["src/index.ts", "package.json", ...]
 */

import { join, relative, isAbsolute } from "path";
import { readTool } from "./read";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { bashTool } from "./bash";
import type { ToolSpec } from "../types";
import { defineTool } from "../tool";
import type { AgentToolPolicy } from "../../types";
import type { ToolResultCache } from "./result-cache";
import { unwrapUntrustedRepositoryContent } from "../untrusted-content";

export interface TrackedTools {
  /** The wrapped tools array — pass this to the agent */
  tools: ToolSpec[];
  /** Get all source files accessed during the agent's run */
  getAccessedFiles: () => string[];
  /** Get source files discovered by broad search tools such as Glob. */
  getDiscoveredFiles: () => string[];
  /** Reset the accessed files tracker */
  reset: () => void;
}

export interface TrackedToolsOptions {
  resultCache?: ToolResultCache;
}

/**
 * Create read-only tools that track which files the AI agent accesses.
 * Returns the tools array plus a function to retrieve accessed file paths.
 */
export function createTrackedTools(
  cwd: string,
  policy: AgentToolPolicy,
  options: TrackedToolsOptions = {},
): TrackedTools {
  const accessedFiles = new Set<string>();
  const discoveredFiles = new Set<string>();

  // Helper to normalize and record a file path
  const normalizeProjectPath = (filePath: string): string | null => {
    const relativePath = (
      isAbsolute(filePath) ? relative(cwd, filePath) : filePath
    ).replace(/\\/g, "/").replace(/^\.\/+/, "");
    const segments = relativePath.split("/");
    if (
      relativePath.length > 0 &&
      !relativePath.startsWith("/") &&
      !relativePath.includes("\0") &&
      segments.every(
        (segment) =>
          segment.length > 0 && segment !== "." && segment !== "..",
      )
    ) {
      return segments.join("/");
    }
    return null;
  };

  const recordFile = (filePath: string) => {
    const rel = normalizeProjectPath(filePath);
    if (rel) accessedFiles.add(rel);
  };

  const recordDiscoveredFile = (filePath: string) => {
    const rel = normalizeProjectPath(filePath);
    if (rel) discoveredFiles.add(rel);
  };

  // Helper to extract file paths from grep output lines
  const extractFilesFromGrepOutput = (output: string) => {
    for (const line of output.split("\n")) {
      // Grep output format: /path/to/file:linenum:content
      const match = line.match(/^(.+?):\d+:/);
      if (match) {
        recordFile(match[1]);
      }
    }
  };

  // Wrap Read tool
  const originalRead = readTool(cwd);
  const trackedRead = defineTool({
    name: originalRead.name,
    description: originalRead.description,
    parameters: originalRead.parameters,
    execute: async (args: { path: string }, context) => {
      recordFile(args.path);
      return resolveToolResult(
        originalRead.name,
        args,
        () => originalRead.execute(args, context),
        options.resultCache,
        context?.markToolReused,
      );
    },
  });

  // Wrap Glob tool — record the files found (not the pattern itself)
  const originalGlob = globTool(cwd);
  const trackedGlob = defineTool({
    name: originalGlob.name,
    description: originalGlob.description,
    parameters: originalGlob.parameters,
    execute: async (args: { pattern: string; path?: string }, context) => {
      const result = await resolveToolResult(
        originalGlob.name,
        args,
        () => originalGlob.execute(args, context),
        options.resultCache,
        context?.markToolReused,
      );
      // Glob returns newline-separated file paths
      if (!result.startsWith("No files found") && !result.startsWith("Error")) {
        // The list sits inside an untrusted-data block; only its lines are paths.
        for (const line of unwrapUntrustedRepositoryContent(result).split("\n")) {
          const trimmed = line.trim();
          if (trimmed) {
            const basePath = args.path
              ? isAbsolute(args.path) ? args.path : join(cwd, args.path)
              : cwd;
            const fullPath = join(basePath, trimmed);
            recordDiscoveredFile(fullPath);
          }
        }
      }
      return result;
    },
  });

  // Wrap Grep tool — record files that had matches
  const originalGrep = grepTool(cwd);
  const trackedGrep = defineTool({
    name: originalGrep.name,
    description: originalGrep.description,
    parameters: originalGrep.parameters,
    execute: async (
      args: { pattern: string; path?: string; glob?: string },
      context,
    ) => {
      const result = await resolveToolResult(
        originalGrep.name,
        args,
        () => originalGrep.execute(args, context),
        options.resultCache,
        context?.markToolReused,
      );
      if (!result.startsWith("No matches") && !result.startsWith("Error")) {
        extractFilesFromGrepOutput(result);
      }
      return result;
    },
  });

  const tools: ToolSpec[] = [trackedRead, trackedGlob, trackedGrep];
  if (policy === "local_shell") {
    tools.push(bashTool(cwd));
  }

  return {
    tools,
    getAccessedFiles: () => [...accessedFiles].sort(),
    getDiscoveredFiles: () => [...discoveredFiles].sort(),
    reset: () => {
      accessedFiles.clear();
      discoveredFiles.clear();
    },
  };
}

export function createTrackedReadOnlyTools(cwd: string): TrackedTools {
  return createTrackedTools(cwd, "read_only");
}

/**
 * Create policy-scoped exploration tools with file access tracking.
 */
export function createTrackedExplorationTools(
  cwd: string,
  policy: AgentToolPolicy,
): TrackedTools {
  return createTrackedTools(cwd, policy);
}

async function resolveToolResult(
  toolName: string,
  args: unknown,
  compute: () => Promise<string>,
  resultCache: ToolResultCache | undefined,
  markToolReused: (() => void) | undefined,
): Promise<string> {
  if (!resultCache) return compute();

  let computed = false;
  const result = await resultCache.resolve(toolName, args, async () => {
    computed = true;
    return compute();
  });
  if (!computed) {
    markToolReused?.();
  }
  return result;
}

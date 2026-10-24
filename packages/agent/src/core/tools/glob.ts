/**
 * Glob Tool — Find files matching a glob pattern.
 */

import { z } from "zod/v4";
import { defineTool } from "../tool";
import { scanGlob } from "../../utils/runtime";
import { resolveProjectPath } from "./project-path";

export function globTool(cwd: string) {
  return defineTool({
    name: "Glob",
    description:
      "Find files matching a glob pattern. Returns a list of matching file paths relative to the search directory.",
    parameters: z.object({
      pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.tsx')"),
      path: z.string().optional().describe("Directory to search in (default: project root)"),
    }),
    execute: async ({ pattern, path }) => {
      try {
        const searchDir = await resolveProjectPath(cwd, path ?? ".");
        const matches = await scanGlob(pattern, searchDir, { limit: 180 });
        if (matches.length === 0) {
          return `No files found matching pattern "${pattern}" in ${searchDir}`;
        }
        matches.sort();
        return matches.join("\n");
      } catch (err) {
        return `Error globbing: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

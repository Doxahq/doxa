import { z } from "zod";
import type { WorkspaceAdapter } from "../adapters/types";
import { defineTool } from "./tool";
import type { ToolSpec } from "./types";

export function createWorkspaceReadTools(workspace: WorkspaceAdapter): ToolSpec[] {
  return [
    defineTool({
      name: "Read",
      description: "Read a project file by path.",
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const content = await workspace.readText(path);
        return content === null ? `Error: File not found: ${path}` : content;
      },
    }),
    defineTool({
      name: "Glob",
      description: "List project files with an optional prefix or glob.",
      parameters: z.object({
        prefix: z.string().optional(),
        glob: z.string().optional(),
      }),
      execute: async (args) => {
        const files = await workspace.listFiles(args);
        return files.length ? files.join("\n") : "No files found";
      },
    }),
    defineTool({
      name: "Grep",
      description: "Search project files using a regular expression.",
      parameters: z.object({
        pattern: z.string(),
        prefix: z.string().optional(),
        glob: z.string().optional(),
      }),
      execute: async ({ pattern, ...options }) => {
        const matches = await workspace.grep(pattern, options);
        return matches.length
          ? matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n")
          : `No matches found for pattern "${pattern}"`;
      },
    }),
  ];
}

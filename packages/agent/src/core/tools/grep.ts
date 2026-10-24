/**
 * Grep Tool — Search file contents for a pattern.
 */

import { z } from "zod/v4";
import { defineTool } from "../tool";
import { runCommand } from "../../utils/runtime";
import { resolveProjectPath } from "./project-path";

const GREP_TIMEOUT_MS = 10_000;
const EXCLUDED_DIRECTORIES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
] as const;

export function grepTool(cwd: string) {
  return defineTool({
    name: "Grep",
    description:
      "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
    parameters: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("File or directory to search in (default: project root)"),
      glob: z.string().optional().describe("File glob filter (e.g. '*.ts')"),
    }),
    execute: async ({ pattern, path, glob: fileGlob }) => {
      try {
        const searchPath = await resolveProjectPath(cwd, path ?? ".");
        const args = [
          "grep",
          "-rn",
          "-I",
          ...EXCLUDED_DIRECTORIES.map(
            (directory) => `--exclude-dir=${directory}`,
          ),
          "--include=*.ts",
          "--include=*.tsx",
          "--include=*.js",
          "--include=*.jsx",
          "--include=*.json",
          "--include=*.md",
          "--include=*.yaml",
          "--include=*.yml",
          "--include=*.toml",
        ];

        if (fileGlob) {
          // Replace generic includes with user-specified glob
          args.splice(
            3 + EXCLUDED_DIRECTORIES.length,
            args.length,
            `--include=${fileGlob}`,
          );
        }

        args.push("-E", pattern, searchPath);

        const result = await runCommand(args, {
          cwd,
          timeoutMs: GREP_TIMEOUT_MS,
        });
        const stdout = result.stdout;
        const stderr = result.stderr;

        if (result.timedOut) {
          return `Error: grep timed out after ${GREP_TIMEOUT_MS}ms; narrow the path or pattern`;
        }

        if (!stdout.trim() && result.exitCode !== 0 && result.exitCode !== 1) {
          return `Error: grep failed: ${stderr}`;
        }

        if (!stdout.trim()) {
          return `No matches found for pattern "${pattern}"`;
        }

        // Truncate if too long
        const lines = stdout.trim().split("\n");
        if (lines.length > 80) {
          return lines.slice(0, 80).join("\n") + `\n... (${lines.length - 80} more matches; narrow the path or pattern)`;
        }

        return stdout.trim();
      } catch (err) {
        return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

/**
 * Grep Tool — Search file contents for a pattern.
 */

import { z } from "zod/v4";
import { defineTool } from "../tool";
import { runCommand } from "../../utils/runtime";
import {
  SENSITIVE_FILE_GLOBS,
  globCanSelectSensitiveFile,
  isProtectedFilePath,
  resolveReadableProjectPath,
} from "./file-access-rules";

const GREP_TIMEOUT_MS = 10_000;
const MAX_MATCH_LINES = 80;
const EXCLUDED_DIRECTORIES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
] as const;
const DEFAULT_INCLUDE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.json",
  "*.md",
  "*.yaml",
  "*.yml",
  "*.toml",
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
        const searchPath = await resolveReadableProjectPath(cwd, path ?? ".");
        if (searchPath === null) {
          return `Skipped sensitive file: ${path}. Search source files instead.`;
        }

        const result = await runCommand(buildGrepCommand(pattern, searchPath, fileGlob), {
          cwd,
          timeoutMs: GREP_TIMEOUT_MS,
        });
        const stdout = result.stdout;

        if (result.timedOut) {
          return `Error: grep timed out after ${GREP_TIMEOUT_MS}ms; narrow the path or pattern`;
        }

        if (!stdout.trim() && result.exitCode !== 0 && result.exitCode !== 1) {
          return `Error: grep failed: ${result.stderr}`;
        }

        const lines = withoutSensitiveMatches(stdout.trim().split("\n").filter(Boolean));
        if (lines.length === 0) {
          return `No matches found for pattern "${pattern}"`;
        }

        if (lines.length > MAX_MATCH_LINES) {
          return lines.slice(0, MAX_MATCH_LINES).join("\n")
            + `\n... (${lines.length - MAX_MATCH_LINES} more matches; narrow the path or pattern)`;
        }

        return lines.join("\n");
      } catch (err) {
        return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

/**
 * Builds the grep argument list. The excludes come after the includes, because
 * grep lets the last matching rule win. `--` ends the options, so a pattern
 * that starts with "-" stays a pattern.
 */
function buildGrepCommand(pattern: string, searchPath: string, fileGlob: string | undefined): string[] {
  const includeGlobs = fileGlob && !globCanSelectSensitiveFile(fileGlob)
    ? [fileGlob]
    : DEFAULT_INCLUDE_GLOBS;

  return [
    "grep",
    "-rn",
    "-I",
    ...EXCLUDED_DIRECTORIES.map((directory) => `--exclude-dir=${directory}`),
    ...includeGlobs.map((glob) => `--include=${glob}`),
    ...SENSITIVE_FILE_GLOBS.map((glob) => `--exclude=${glob}`),
    "-E",
    "--",
    pattern,
    searchPath,
  ];
}

/**
 * Drops match lines from protected files: screened files have no basename
 * exclude, and a grep build can ignore an exclude.
 */
function withoutSensitiveMatches(lines: string[]): string[] {
  return lines.filter((line) => {
    const filePath = matchLineFilePath(line);
    return filePath === null || !isProtectedFilePath(filePath);
  });
}

/** Reads the file path from a `path:line:text` match line. */
function matchLineFilePath(line: string): string | null {
  const match = /^(.*?):\d+:/.exec(line);
  return match?.[1] ?? null;
}

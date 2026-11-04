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

        const lines = readableMatchLines(stdout);
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
 * that starts with "-" stays a pattern. `-H` and `--null` write a NUL after
 * each file name, the one byte that a file name cannot hold, so the output
 * gives the real name of each file.
 */
function buildGrepCommand(pattern: string, searchPath: string, fileGlob: string | undefined): string[] {
  const includeGlobs = fileGlob && !globCanSelectSensitiveFile(fileGlob)
    ? [fileGlob]
    : DEFAULT_INCLUDE_GLOBS;

  return [
    "grep",
    "-rn",
    "-H",
    "--null",
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
 * The match lines as `path:line:text`, without the lines of protected files:
 * screened files and credential paths such as `.aws/credentials` have no
 * basename exclude, grep matches an exclude in exact case only, and a grep
 * build can ignore an exclude.
 */
function readableMatchLines(stdout: string): string[] {
  return parseMatches(stdout)
    .filter((match) => !isProtectedFilePath(match.filePath))
    .map((match) => `${match.filePath}:${match.lineAndText}`);
}

interface GrepMatch {
  filePath: string;
  /** `line:text`, the part of the match after the file name. */
  lineAndText: string;
}

/**
 * Reads `path NUL line:text LF` records. A file name can hold `:` and a line
 * feed, so only the NUL ends a name, and only a line feed ends the text. A
 * record that has another shape has no name to check, so it is dropped.
 */
function parseMatches(stdout: string): GrepMatch[] {
  const [firstPath = "", ...fields] = stdout.split("\0");
  const matches: GrepMatch[] = [];
  let filePath = firstPath;
  for (const field of fields) {
    const lineEnd = field.indexOf("\n");
    const lineAndText = lineEnd === -1 ? field : field.slice(0, lineEnd);
    if (filePath && /^\d+:/.test(lineAndText)) matches.push({ filePath, lineAndText });
    filePath = lineEnd === -1 ? "" : field.slice(lineEnd + 1);
  }
  return matches;
}

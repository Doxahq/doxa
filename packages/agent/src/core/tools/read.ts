/**
 * Read Tool — Read file contents with line numbers.
 */

import { z } from "zod/v4";
import { defineTool } from "../tool";
import { fileExists, readTextFile } from "../../utils/runtime";
import { isLargeFilePath, resolveReadableProjectPath } from "./file-access-rules";
import { wrapUntrustedRepositoryContent } from "../untrusted-content";

const MAX_READ_CHARS = 8_000;
const MAX_READ_LINES = 180;

export function readTool(cwd: string) {
  return defineTool({
    name: "Read",
    description:
      "Read a file's contents. Returns the content with line numbers. Use absolute paths or paths relative to the project root.",
    parameters: z.object({
      path: z.string().describe("File path to read (absolute or relative to project root)"),
    }),
    execute: async ({ path }) => {
      try {
        // The resolved path catches a harmless-looking symlink to a secret file.
        const fullPath = await resolveReadableProjectPath(cwd, path);
        if (fullPath === null || isLargeFilePath(path)) {
          return `Skipped large or sensitive file: ${path}. Read the package manifest or specific source files instead.`;
        }

        if (!(await fileExists(fullPath))) {
          return `Error: File not found: ${fullPath}`;
        }
        const content = await readTextFile(fullPath);
        const truncatedContent = content.length > MAX_READ_CHARS
          ? `${content.slice(0, MAX_READ_CHARS)}\n... (truncated ${content.length - MAX_READ_CHARS} chars; read a more specific file or grep for a narrower pattern)`
          : content;
        const lines = truncatedContent.split("\n");
        const limitedLines = lines.length > MAX_READ_LINES
          ? [
              ...lines.slice(0, MAX_READ_LINES),
              `... (truncated ${lines.length - MAX_READ_LINES} lines; read a more specific file or grep for a narrower pattern)`,
            ]
          : lines;
        // The file text is repository data, never instructions to the model.
        return wrapUntrustedRepositoryContent(
          limitedLines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join("\n"),
          path,
        );
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

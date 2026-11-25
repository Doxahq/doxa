/**
 * Bash Tool — Execute shell commands.
 */

import { z } from "zod/v4";
import { defineTool } from "../tool";
import { runCommand } from "../../utils/runtime";
import { wrapUntrustedRepositoryContent } from "../untrusted-content";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

export function bashTool(cwd: string) {
  return defineTool({
    name: "Bash",
    description:
      "Execute a shell command and return stdout/stderr. Use for running CLI help commands, listing directories, or other system operations.",
    parameters: z.object({
      command: z.string().describe("Shell command to execute"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default: 30000)"),
    }),
    execute: async ({ command, timeout }) => {
      const timeoutMs = timeout || DEFAULT_TIMEOUT;
      try {
        const result = await runCommand(["sh", "-c", command], { cwd, timeoutMs });
        if (result.timedOut) {
          return `Error: Command timed out after ${timeoutMs}ms: ${command}`;
        }

        let output = "";
        if (result.stdout.trim()) output += result.stdout.trim();
        if (result.stderr.trim()) {
          if (output) output += "\n\n--- stderr ---\n";
          output += result.stderr.trim();
        }

        if (!output) output = `(no output, exit code: ${result.exitCode})`;

        // Truncate very long output
        if (output.length > 10_000) {
          output = output.slice(0, 10_000) + "\n... (output truncated)";
        }

        // Command output reads the repository, so it is data, never instructions.
        return wrapUntrustedRepositoryContent(output, "shell command output");
      } catch (err) {
        return `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

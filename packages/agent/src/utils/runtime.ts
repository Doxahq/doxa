import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { compilePathGlob, normalizePath } from "./path-glob";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".wrangler",
]);

export async function fileExists(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isFile();
  } catch {
    return false;
  }
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

export function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

export async function runCommand(
  command: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const [bin, ...args] = command;
  if (!bin) throw new Error("Command cannot be empty.");

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function scanGlob(
  pattern: string,
  cwd: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  const files = await listProjectFiles(cwd);
  const matches = compilePathGlob(pattern);
  const found: string[] = [];

  for (const file of files.sort()) {
    if (!matches(file)) continue;
    found.push(file);
    if (options.limit && found.length >= options.limit) break;
  }

  return found;
}

/**
 * Lists project files the exploration tools can see, relative to `root`.
 * Skips `DEFAULT_IGNORES` directories and does not follow symbolic links.
 */
export function listProjectFiles(root: string): Promise<string[]> {
  return listFiles(root, root);
}

async function listFiles(root: string, current: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(normalizePath(relative(root, fullPath)));
    }
  }
  return files;
}

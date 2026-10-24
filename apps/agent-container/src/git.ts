import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { rm } from "node:fs/promises";
import {
  createGitCredentialSession,
  type GitCredentialSessionFactory,
} from "./git-credentials";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<CommandResult>;

export interface CloneRepositoryInput {
  fullName: string;
  branch?: string;
  token: string;
  targetDir: string;
}

export interface CloneRepositoryOptions {
  skipGitCheck?: boolean;
  retryDelay?: GitRetryDelay;
  signal?: AbortSignal;
  credentialSessionFactory?: GitCredentialSessionFactory;
}

export type GitRetryDelay = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface GitHubRetryEvent {
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

export interface GitHubRetryOptions {
  beforeRetry?: () => Promise<void>;
  onRetry?: (event: GitHubRetryEvent) => Promise<void> | void;
  random?: () => number;
  retryDelay?: GitRetryDelay;
  signal?: AbortSignal;
}

export const missingGitMessage =
  "git is not installed in the agent container image. Rebuild and redeploy apps/agent-container.";

export const defaultCommandRunner: CommandRunner = (
  file,
  args,
  options,
) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const result = {
        stdout: normalizeCommandOutput(stdout),
        stderr: normalizeCommandOutput(stderr),
      };
      if (error) {
        Object.assign(error, result);
        reject(error);
        return;
      }
      resolve(result);
    });
  });
const maxGitHubAttempts = 3;
const githubRetryBaseDelayMs = 1_000;

export async function assertGitAvailable(
  commandRunner: CommandRunner = defaultCommandRunner,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  try {
    await commandRunner("git", ["--version"], {
      timeout: 5_000,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new Error(missingGitMessage);
    }

    const message = error instanceof Error ? error.message : "git prerequisite check failed";
    throw new Error(`git prerequisite check failed: ${message}`);
  }
}

export async function cloneRepository(
  input: CloneRepositoryInput,
  commandRunner: CommandRunner = defaultCommandRunner,
  options: CloneRepositoryOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!options.skipGitCheck) {
    await assertGitAvailable(commandRunner, options.signal);
  }

  const args = buildCloneArgs(input);
  const repositoryUrl = createRepositoryUrl(input.fullName);
  const credentialSession = await (
    options.credentialSessionFactory ?? createGitCredentialSession
  )(input.token);

  try {
    try {
      await retryGitHubOperation(
        async () => {
          await commandRunner("git", args, {
            timeout: 120_000,
            env: credentialSession.environment,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          await setAndVerifyCleanRemote(
            commandRunner,
            input.targetDir,
            repositoryUrl,
            options.signal,
          );
        },
        {
          signal: options.signal,
          retryDelay: options.retryDelay,
          beforeRetry: () =>
            rm(input.targetDir, { recursive: true, force: true }),
        },
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new Error(missingGitMessage);
      }
      throw new Error(sanitizeToken(gitErrorText(error), input.token));
    }
  } finally {
    await credentialSession.dispose();
  }
}

export async function retryGitHubOperation<T>(
  operation: () => Promise<T>,
  options: GitHubRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxGitHubAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!isTransientNetworkFailure(error)) {
        throw error;
      }
      if (attempt === maxGitHubAttempts) {
        throw new Error(
          `We couldn't connect to GitHub after ${maxGitHubAttempts} attempts. ` +
            "Please try generating the documentation again in a few minutes.",
        );
      }

      const delayMs = jitteredRetryDelay(
        githubRetryBaseDelayMs * 2 ** (attempt - 1),
        options.random?.() ?? Math.random(),
      );
      await options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: maxGitHubAttempts,
        delayMs,
        error,
      });
      await options.beforeRetry?.();
      await (options.retryDelay ?? delay)(
        delayMs,
        options.signal,
      );
    }
  }

  throw new Error("GitHub operation retry loop exited unexpectedly.");
}

function jitteredRetryDelay(baseDelayMs: number, randomValue: number): number {
  const boundedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5;
  return Math.round(baseDelayMs * (0.5 + boundedRandom));
}

export function buildCloneArgs(input: CloneRepositoryInput): string[] {
  const args = ["clone", "--depth", "1"];
  if (input.branch) {
    args.push("--branch", input.branch);
  }

  args.push(createRepositoryUrl(input.fullName), input.targetDir);
  return args;
}

export function createRepositoryUrl(fullName: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("GitHub repository name is invalid.");
  }

  return `https://github.com/${fullName}.git`;
}

export function sanitizeToken(value: string, token: string): string {
  const tokenRedacted = token
    ? [token, encodeURIComponent(token)].reduce(
        (current, candidate) => current.split(candidate).join("[redacted]"),
        value,
      )
    : value;

  return tokenRedacted.replace(
    /https:\/\/x-access-token:[^@\s]+@/gi,
    "https://x-access-token:[redacted]@",
  );
}

async function setAndVerifyCleanRemote(
  commandRunner: CommandRunner,
  targetDir: string,
  repositoryUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const options: ExecFileOptions = {
    timeout: 10_000,
    ...(signal ? { signal } : {}),
  };
  await commandRunner(
    "git",
    ["-C", targetDir, "remote", "set-url", "origin", repositoryUrl],
    options,
  );
  const result = await commandRunner(
    "git",
    ["-C", targetDir, "remote", "get-url", "origin"],
    options,
  );

  if (result.stdout.trim() !== repositoryUrl) {
    throw new Error("Git remote verification failed.");
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isTransientNetworkFailure(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "killed" in error &&
    error.killed === true &&
    "signal" in error &&
    error.signal === "SIGTERM"
  ) {
    return true;
  }

  if (isErrnoException(error) && typeof error.code === "string") {
    const transientCodes = [
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
    ];
    if (transientCodes.includes(error.code)) {
      return true;
    }
  }

  const message = gitErrorText(error).toLowerCase();
  return [
    "connection reset by peer",
    "could not resolve host",
    "could not resolve proxy",
    "couldn't connect to server",
    "failed to connect",
    "network is unreachable",
    "operation timed out",
  ].some((fragment) => message.includes(fragment));
}

function gitErrorText(error: unknown): string {
  const messages: string[] = [];
  if (error instanceof Error && error.message) {
    messages.push(error.message);
  }
  if (typeof error === "object" && error !== null) {
    if ("stdout" in error && typeof error.stdout === "string" && error.stdout.trim()) {
      messages.push(error.stdout.trim());
    }
    if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
      messages.push(error.stderr.trim());
    }
  }

  return [...new Set(messages)].join("\n") || "git clone failed";
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeCommandOutput(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

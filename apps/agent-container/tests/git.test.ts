import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  assertGitAvailable,
  buildCloneArgs,
  cloneRepository,
  createRepositoryUrl,
  missingGitMessage,
  retryGitHubOperation,
  sanitizeToken,
  type CommandRunner,
  type CloneRepositoryInput,
} from "../src/git";
import type { GitCredentialSessionFactory } from "../src/git-credentials";

const baseInput: CloneRepositoryInput = {
  fullName: "ipenywis/flagforge",
  branch: "main",
  token: "install-token",
  targetDir: "/tmp/doxa-job",
};

describe("agent container git prerequisite", () => {
  test("checks git version before clone work", async () => {
    const runner = createRunner();

    await assertGitAvailable(runner);

    expect(runner).toHaveBeenCalledWith("git", ["--version"], { timeout: 5_000 });
  });

  test("reports missing git as image rebuild action", async () => {
    const runner = createRunner([missingBinaryError()]);

    await expect(assertGitAvailable(runner)).rejects.toThrow(missingGitMessage);
  });

  test("wraps git prerequisite command failures", async () => {
    const runner = createRunner([new Error("permission denied")]);

    await expect(assertGitAvailable(runner)).rejects.toThrow(
      "git prerequisite check failed: permission denied",
    );
  });
});

describe("agent container git clone command", () => {
  const cases: Array<{
    name: string;
    input: CloneRepositoryInput;
    expectedArgs: string[];
  }> = [
    {
      name: "includes selected branch",
      input: baseInput,
      expectedArgs: [
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        createRepositoryUrl(baseInput.fullName),
        baseInput.targetDir,
      ],
    },
    {
      name: "omits branch when absent",
      input: { ...baseInput, branch: undefined },
      expectedArgs: [
        "clone",
        "--depth",
        "1",
        createRepositoryUrl(baseInput.fullName),
        baseInput.targetDir,
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(buildCloneArgs(c.input)).toEqual(c.expectedArgs);
    });
  }

  test("builds a clean GitHub repository URL", () => {
    const repositoryUrl = new URL(createRepositoryUrl("ipenywis/flagforge"));

    expect(repositoryUrl.protocol).toBe("https:");
    expect(repositoryUrl.hostname).toBe("github.com");
    expect(repositoryUrl.username).toBe("");
    expect(repositoryUrl.password).toBe("");
    expect(repositoryUrl.pathname).toBe("/ipenywis/flagforge.git");
  });

  test("rejects invalid repository names before invoking git", async () => {
    const runner = createRunner();

    await expect(
      cloneRepository({ ...baseInput, fullName: "github.com/owner/repository" }, runner),
    ).rejects.toThrow("GitHub repository name is invalid.");

    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("runs prerequisite check before clone", async () => {
    const runner = createRunner();

    await cloneRepository(baseInput, runner);

    expect(runner).toHaveBeenNthCalledWith(1, "git", ["--version"], { timeout: 5_000 });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "git",
      buildCloneArgs(baseInput),
      expect.objectContaining({
        timeout: 120_000,
        env: expect.objectContaining({
          DOXA_GIT_TOKEN: baseInput.token,
          GIT_TERMINAL_PROMPT: "0",
        }),
      }),
    );
    expect(runner).toHaveBeenNthCalledWith(
      3,
      "git",
      ["-C", baseInput.targetDir, "remote", "set-url", "origin", createRepositoryUrl(baseInput.fullName)],
      { timeout: 10_000 },
    );
    expect(runner).toHaveBeenNthCalledWith(
      4,
      "git",
      ["-C", baseInput.targetDir, "remote", "get-url", "origin"],
      { timeout: 10_000 },
    );
  });

  test("passes cancellation to the git child process and does not retry after abort", async () => {
    const controller = new AbortController();
    const cancelled = new Error("Generation cancelled by user.");
    const credentials = createCredentialHarness();
    const runner = vi.fn<CommandRunner>(async (_file, args, options) => {
      if (args[0] === "--version") return ok();

      expect(options.signal).toBe(controller.signal);
      controller.abort(cancelled);
      throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    });

    await expect(
      cloneRepository(baseInput, runner, {
        signal: controller.signal,
        credentialSessionFactory: credentials.factory,
      }),
    ).rejects.toBe(cancelled);

    expect(runner).toHaveBeenCalledTimes(2);
    expect(credentials.dispose).toHaveBeenCalledOnce();
  });

  test("retries transient network failures and succeeds on the third clone attempt", async () => {
    const runner = createRunner([
      ok(),
      githubConnectionError(),
      githubConnectionError(),
      ok(),
    ]);

    await expect(
      cloneRepository(baseInput, runner, { retryDelay: noRetryDelay }),
    ).resolves.toBeUndefined();

    expect(runner).toHaveBeenCalledTimes(6);
    expect(runner).toHaveBeenNthCalledWith(
      4,
      "git",
      buildCloneArgs(baseInput),
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  test("reports a user-friendly error after three transient network failures", async () => {
    const runner = createRunner([
      ok(),
      githubConnectionError(),
      githubConnectionError(),
      githubConnectionError(),
    ]);

    const error = await captureError(() =>
      cloneRepository(baseInput, runner, { retryDelay: noRetryDelay }),
    );

    expect(error.message).toBe(
      "We couldn't connect to GitHub after 3 attempts. Please try generating the documentation again in a few minutes.",
    );
    expect(error.message).not.toContain("git clone");
    expect(error.message).not.toContain("fatal:");

    expect(runner).toHaveBeenCalledTimes(4);
  });

  test("retries temporary GitHub DNS resolution failures", async () => {
    const runner = createRunner([
      ok(),
      new Error("fatal: unable to access 'https://github.com/ipenywis/flagforge.git/': Could not resolve host: github.com"),
      ok(),
    ]);

    await expect(
      cloneRepository(baseInput, runner, { retryDelay: noRetryDelay }),
    ).resolves.toBeUndefined();

    expect(runner).toHaveBeenCalledTimes(5);
  });

  test("retries common transient Git transport failures", async () => {
    const messages = [
      "Could not resolve proxy: proxy.local",
      "Operation timed out after 120000 milliseconds",
      "Recv failure: Connection reset by peer",
      "Network is unreachable",
    ];

    for (const message of messages) {
      const runner = createRunner([ok(), new Error(message), ok()]);
      await expect(
        cloneRepository(baseInput, runner, { retryDelay: noRetryDelay }),
      ).resolves.toBeUndefined();
      expect(runner).toHaveBeenCalledTimes(5);
    }
  });

  test("retries a Git command terminated by its execution timeout", async () => {
    const timeoutError = Object.assign(
      new Error("Command failed: git clone"),
      {
        killed: true,
        signal: "SIGTERM",
      },
    );
    const runner = createRunner([ok(), timeoutError, ok()]);

    await expect(
      cloneRepository(baseInput, runner, { retryDelay: noRetryDelay }),
    ).resolves.toBeUndefined();

    expect(runner).toHaveBeenCalledTimes(5);
  });

  test("removes a partial checkout before retrying", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "doxa-clone-retry-"));
    const partialFile = join(targetDir, "partial-checkout");
    await writeFile(partialFile, "incomplete");
    let cloneAttempts = 0;
    const runner = vi.fn<CommandRunner>(async (_file, args) => {
      if (args[0] === "--version") return ok();
      if (args.includes("set-url")) return ok();
      if (args.includes("get-url")) {
        return ok(`${createRepositoryUrl(baseInput.fullName)}\n`);
      }

      cloneAttempts += 1;
      if (cloneAttempts === 1) {
        throw githubConnectionError();
      }

      await expect(access(partialFile)).rejects.toThrow();
      return ok();
    });

    try {
      await expect(
        cloneRepository({ ...baseInput, targetDir }, runner, { retryDelay: noRetryDelay }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }

    expect(cloneAttempts).toBe(2);
  });

  test("reports missing git during clone as image rebuild action", async () => {
    const runner = createRunner([ok(), missingBinaryError()]);

    await expect(cloneRepository(baseInput, runner)).rejects.toThrow(missingGitMessage);
  });

  test("disposes temporary credentials after a failed clone", async () => {
    const credentials = createCredentialHarness();
    const runner = createRunner([ok(), new Error("permission denied")]);

    await expect(
      cloneRepository(baseInput, runner, {
        credentialSessionFactory: credentials.factory,
      }),
    ).rejects.toThrow("permission denied");

    expect(credentials.dispose).toHaveBeenCalledOnce();
  });

  test("redacts raw token from clone failures", async () => {
    const runner = createRunner([
      ok(),
      new Error("fatal: could not read from https://x-access-token:install-token@github.com/ipenywis/flagforge.git"),
    ]);

    const error = await captureError(() => cloneRepository(baseInput, runner));

    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("install-token");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test("redacts encoded token from clone failures", () => {
    const token = "tok/en:@x";
    const message = `fatal: https://x-access-token:${encodeURIComponent(token)}@github.com failed`;

    expect(sanitizeToken(message, token)).toBe("fatal: https://x-access-token:[redacted]@github.com failed");
  });

  test("redacts tokens found in Git process stdout and stderr", async () => {
    const token = "sentinel/token:@42";
    const processError = Object.assign(
      new Error(`clone failed for ${token}`),
      {
        stdout: `remote output ${encodeURIComponent(token)}`,
        stderr: `fatal: https://x-access-token:${token}@github.com failed`,
      },
    );
    const runner = createRunner([ok(), processError]);

    const error = await captureError(() =>
      cloneRepository({ ...baseInput, token }, runner),
    );

    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain(encodeURIComponent(token));
  });

  test("keeps credentials out of command arguments and persisted remote configuration", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "doxa-clone-credentials-"));
    const token = "doxa-sentinel-token-42";
    const repositoryUrl = createRepositoryUrl(baseInput.fullName);
    const commandOutputs: CommandResult[] = [];
    const runner = vi.fn<CommandRunner>(async (_file, args) => {
      expect(args.join(" ")).not.toContain(token);

      if (args[0] === "--version") return recordOutput(commandOutputs, ok("git version 2\n"));
      if (args[0] === "clone") {
        await mkdir(join(targetDir, ".git"), { recursive: true });
        await writeFile(
          join(targetDir, ".git/config"),
          `[remote "origin"]\n\turl = ${repositoryUrl}\n`,
          "utf8",
        );
        return recordOutput(commandOutputs, ok("clone complete\n"));
      }
      if (args.includes("set-url")) return recordOutput(commandOutputs, ok());
      if (args.includes("get-url")) {
        return recordOutput(commandOutputs, ok(`${repositoryUrl}\n`));
      }
      throw new Error("Unexpected Git command.");
    });

    try {
      const result = await cloneRepository(
        { ...baseInput, targetDir, token },
        runner,
      );
      const gitConfig = await readFile(join(targetDir, ".git/config"), "utf8");

      expect(result).toBeUndefined();
      expect(gitConfig).not.toContain(token);
      expect(commandOutputs.every((output) =>
        !output.stdout.includes(token) && !output.stderr.includes(token)
      )).toBe(true);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});

describe("GitHub retry policy", () => {
  test("reports retries and applies jitter to exponential backoff", async () => {
    const delays: number[] = [];
    const retries: Array<{
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      error: unknown;
    }> = [];
    const transientError = githubConnectionError();
    let attempts = 0;

    const result = await retryGitHubOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw transientError;
        }
        return "connected";
      },
      {
        random: () => 1,
        retryDelay: async (milliseconds) => {
          delays.push(milliseconds);
        },
        onRetry: (retry) => {
          retries.push(retry);
        },
      },
    );

    expect(result).toBe("connected");
    expect(delays).toEqual([1_500, 3_000]);
    expect(retries).toEqual([
      {
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 1_500,
        error: transientError,
      },
      {
        attempt: 2,
        nextAttempt: 3,
        maxAttempts: 3,
        delayMs: 3_000,
        error: transientError,
      },
    ]);
  });
});

type CommandOutcome = Error | ReturnType<typeof ok>;

function createRunner(outcomes: CommandOutcome[] = []): CommandRunner {
  return vi.fn<CommandRunner>(async (_file, args) => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (outcome) return outcome;
    if (args.includes("get-url")) {
      return ok(`${createRepositoryUrl(baseInput.fullName)}\n`);
    }
    return ok();
  });
}

function ok(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr };
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function recordOutput(outputs: CommandResult[], output: CommandResult): CommandResult {
  outputs.push(output);
  return output;
}

function createCredentialHarness(): {
  factory: GitCredentialSessionFactory;
  dispose: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async (): Promise<void> => {});
  return {
    dispose,
    factory: async (token) => ({
      environment: {
        DOXA_GIT_TOKEN: token,
        GIT_ASKPASS: "/tmp/doxa-test-askpass",
        GIT_TERMINAL_PROMPT: "0",
      },
      dispose,
    }),
  };
}

async function noRetryDelay(): Promise<void> {}

function missingBinaryError(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
}

function githubConnectionError(): Error {
  return new Error(
    "fatal: unable to access 'https://github.com/ipenywis/flagforge.git/': " +
      "Failed to connect to github.com port 443: Couldn't connect to server",
  );
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
  }

  throw new Error("Expected action to throw.");
}

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  PullRequestMergeCheckout,
  SourceCheckoutSpec,
} from "@doxahq/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureRepositorySnapshot,
  prepareRepositorySnapshot,
} from "../src/repository-snapshot";
import {
  defaultCommandRunner,
  type CommandRunner,
} from "../src/git";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("exact repository snapshot preparation", () => {
  test("materializes a clean synthetic merge with deterministic changes", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-output-");

    const result = await prepareRepositorySnapshot(
      {
        repositoryFullName: "doxa/private-repository",
        installationAccessToken: "installation-token",
        checkoutSpec: fixture.checkoutSpec,
        destination,
      },
      { repositoryUrl: fixture.remote },
    );

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") {
      throw new Error("Expected a prepared repository snapshot.");
    }

    expect(result.snapshot.targetRevision).toBe(fixture.headRevision);
    expect(result.snapshot.changes).toEqual([
      { path: "README.md", status: "modified" },
      { path: "assets/logo.bin", status: "modified" },
      { path: "base-only.md", status: "added" },
      { path: "src/delete-me.ts", status: "deleted" },
      {
        path: "src/renamed.ts",
        previousPath: "src/rename-me.ts",
        status: "renamed",
      },
    ]);
    await expect(
      readFile(join(result.checkoutPath, "base-only.md"), "utf8"),
    ).resolves.toBe("base branch\n");
    await expect(
      readFile(join(result.checkoutPath, "src/renamed.ts"), "utf8"),
    ).resolves.toBe("export const renamed = true;\n");
    await expect(
      access(join(result.checkoutPath, "src/delete-me.ts")),
    ).rejects.toThrow();
    await expect(access(join(result.checkoutPath, ".git"))).rejects.toThrow();

    const controlConfig = await readFile(
      join(destination, "repository.git", "config"),
      "utf8",
    );
    expect(controlConfig).toContain(fixture.remote);
    expect(controlConfig).not.toContain("installation-token");
    expect(await listFiles(destination)).not.toContain("askpass.sh");
  });

  test("rebuilds a reused checkout after local mutation", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-reuse-");
    const input = {
      repositoryFullName: "doxa/private-repository",
      installationAccessToken: "installation-token",
      checkoutSpec: fixture.checkoutSpec,
      destination,
    };
    const first = await ensureRepositorySnapshot(input, {
      repositoryUrl: fixture.remote,
    });
    if (first.outcome !== "prepared") {
      throw new Error("Expected a prepared repository snapshot.");
    }
    await writeFile(join(first.checkoutPath, "README.md"), "mutated\n");

    const second = await ensureRepositorySnapshot(input, {
      repositoryUrl: fixture.remote,
    });

    expect(second.outcome).toBe("prepared");
    if (second.outcome !== "prepared") {
      throw new Error("Expected a prepared repository snapshot.");
    }
    await expect(
      readFile(join(second.checkoutPath, "README.md"), "utf8"),
    ).resolves.toBe("pull request\n");
  });

  test("reuses an unchanged prepared checkout without accessing the remote", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-reuse-");
    const input = {
      repositoryFullName: "doxa/private-repository",
      installationAccessToken: "installation-token",
      checkoutSpec: fixture.checkoutSpec,
      destination,
    };
    const first = await ensureRepositorySnapshot(input, {
      repositoryUrl: fixture.remote,
    });
    if (first.outcome !== "prepared") {
      throw new Error("Expected a prepared repository snapshot.");
    }
    await rm(fixture.remote, { recursive: true });

    const second = await ensureRepositorySnapshot(input, {
      repositoryUrl: fixture.remote,
    });

    expect(second).toEqual(first);
  });

  test("serializes concurrent preparation for the same destination", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-concurrent-");
    let cloneSequences = 0;
    const commandRunner: CommandRunner = async (file, args, options) => {
      if (args[0] === "init" && args[1] === "--bare") {
        cloneSequences += 1;
      }
      return defaultCommandRunner(file, args, options);
    };
    const input = {
      repositoryFullName: "doxa/private-repository",
      installationAccessToken: "installation-token",
      checkoutSpec: fixture.checkoutSpec,
      destination,
    };
    const options = {
      commandRunner,
      repositoryUrl: fixture.remote,
    };

    const [first, second] = await Promise.all([
      ensureRepositorySnapshot(input, options),
      ensureRepositorySnapshot(input, options),
    ]);

    expect(first).toEqual(second);
    expect(first.outcome).toBe("prepared");
    expect(cloneSequences).toBe(1);
  });

  test("returns a merge-conflict domain result", async () => {
    const fixture = await createConflictFixture();
    const destination = await temporaryDirectory("doxa-snapshot-conflict-");

    const result = await prepareRepositorySnapshot(
      {
        repositoryFullName: "doxa/private-repository",
        installationAccessToken: "installation-token",
        checkoutSpec: fixture.checkoutSpec,
        destination,
      },
      { repositoryUrl: fixture.remote },
    );

    expect(result).toEqual({
      outcome: "merge_conflict",
      targetRevision: fixture.headRevision,
      message:
        "The pull request cannot be merged cleanly with its accepted base revision.",
    });
  });

  test("rejects a pull-request ref that moved from the accepted head", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-stale-");
    const checkoutSpec: SourceCheckoutSpec = {
      ...fixture.checkoutSpec,
      headRevision: fixture.baselineRevision,
    };

    await expect(
      prepareRepositorySnapshot(
        {
          repositoryFullName: "doxa/private-repository",
          installationAccessToken: "installation-token",
          checkoutSpec,
          destination,
        },
        { repositoryUrl: fixture.remote },
      ),
    ).rejects.toThrow(
      "The fetched pull-request head no longer matches the accepted revision.",
    );
  });

  test("materializes an exact commit checkout", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-commit-");

    const result = await prepareRepositorySnapshot(
      {
        repositoryFullName: "doxa/private-repository",
        installationAccessToken: "installation-token",
        checkoutSpec: {
          kind: "commit",
          baselineRevision: fixture.baselineRevision,
          targetRevision: fixture.baseRevision,
        },
        destination,
      },
      { repositoryUrl: fixture.remote },
    );

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") {
      throw new Error("Expected a prepared repository snapshot.");
    }
    expect(result.snapshot.changes).toEqual([
      { path: "base-only.md", status: "added" },
    ]);
  });

  test("keeps credentials available while materializing partial-clone blobs", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-credentials-");
    const askpassPath = "/tmp/doxa-test-askpass";
    const credentialEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DOXA_GIT_TOKEN: "installation-token",
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: "0",
    };
    const commandRunner: CommandRunner = async (file, args, options) => {
      if (
        args.includes("read-tree")
        && options.env?.GIT_ASKPASS !== askpassPath
      ) {
        throw new Error(
          "fatal: could not read Username for 'https://github.com': No such device or address",
        );
      }
      return defaultCommandRunner(file, args, options);
    };

    const result = await prepareRepositorySnapshot(
      {
        repositoryFullName: "doxa/private-repository",
        installationAccessToken: "installation-token",
        checkoutSpec: {
          kind: "commit",
          baselineRevision: fixture.baselineRevision,
          targetRevision: fixture.baseRevision,
        },
        destination,
      },
      {
        commandRunner,
        repositoryUrl: fixture.remote,
        credentialSessionFactory: async () => ({
          environment: credentialEnvironment,
          dispose: async () => undefined,
        }),
      },
    );

    expect(result.outcome).toBe("prepared");
    await expect(readFile(join(destination, "checkout", "base-only.md"), "utf8"))
      .resolves.toBe("base branch\n");
  });

  test("keeps credentials available while resolving pull-request trees and changes", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-pr-credentials-");
    const askpassPath = "/tmp/doxa-test-pr-askpass";
    const authenticatedCommands = new Set<string>();
    const credentialEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DOXA_GIT_TOKEN: "installation-token",
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: "0",
    };
    const commandRunner: CommandRunner = async (file, args, options) => {
      const authenticatedCommand = ["merge-tree", "read-tree", "diff"]
        .find((command) => args.includes(command));
      if (authenticatedCommand) {
        if (options.env?.GIT_ASKPASS !== askpassPath) {
          throw new Error(`${authenticatedCommand} cannot authenticate`);
        }
        authenticatedCommands.add(authenticatedCommand);
      }
      return defaultCommandRunner(file, args, options);
    };

    const result = await prepareRepositorySnapshot(
      {
        repositoryFullName: "doxa/private-repository",
        installationAccessToken: "installation-token",
        checkoutSpec: fixture.checkoutSpec,
        destination,
      },
      {
        commandRunner,
        repositoryUrl: fixture.remote,
        credentialSessionFactory: async () => ({
          environment: credentialEnvironment,
          dispose: async () => undefined,
        }),
      },
    );

    expect(result.outcome).toBe("prepared");
    expect(authenticatedCommands).toEqual(
      new Set(["merge-tree", "read-tree", "diff"]),
    );
  });

  test("retries transient GitHub failures while fetching exact revisions", async () => {
    const fixture = await createCleanMergeFixture();
    const destination = await temporaryDirectory("doxa-snapshot-retry-");
    let fetchAttempts = 0;
    const fetchTimeouts: Array<number | undefined> = [];
    const retries: Array<{
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }> = [];
    const commandRunner: CommandRunner = async (file, args, options) => {
      if (args.includes("fetch")) {
        fetchAttempts += 1;
        fetchTimeouts.push(options.timeout);
        if (fetchAttempts < 3) {
          throw new Error(
            "fatal: unable to access " +
              "'https://x-access-token:installation-token@github.com/doxa/private-repository.git/': " +
              "Failed to connect to github.com port 443: Couldn't connect to server",
          );
        }
      }
      return defaultCommandRunner(file, args, options);
    };
    const options = {
      commandRunner,
      repositoryUrl: fixture.remote,
      retryDelay: async () => {},
      random: () => 0.5,
      onRetry: (retry: (typeof retries)[number]) => {
        retries.push(retry);
      },
    };

    const result = await prepareRepositorySnapshot(
      {
        repositoryFullName: "doxa/private-repository",
        installationAccessToken: "installation-token",
        checkoutSpec: fixture.checkoutSpec,
        destination,
      },
      options,
    );

    expect(result.outcome).toBe("prepared");
    expect(fetchAttempts).toBe(3);
    expect(fetchTimeouts).toEqual([10_000, 10_000, 10_000]);
    expect(retries).toMatchObject([
      { attempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 1_000 },
      { attempt: 2, nextAttempt: 3, maxAttempts: 3, delayMs: 2_000 },
    ]);
    expect(retries.every((retry) =>
      retry.reason.includes("[redacted]") &&
      !retry.reason.includes("installation-token")
    )).toBe(true);
  });

  test("aborts snapshot preparation when its total time budget expires", async () => {
    const destination = await temporaryDirectory("doxa-snapshot-timeout-");
    const commandRunner: CommandRunner = async (_file, args, options) => {
      if (!args.includes("fetch")) {
        return { stdout: "", stderr: "" };
      }

      return new Promise((_resolve, reject) => {
        const fallback = setTimeout(
          () => reject(new Error("Fetch outlived the snapshot budget.")),
          150,
        );
        options.signal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          reject(options.signal?.reason);
        }, { once: true });
      });
    };

    await expect(
      prepareRepositorySnapshot(
        {
          repositoryFullName: "doxa/private-repository",
          installationAccessToken: "installation-token",
          checkoutSpec: {
            kind: "commit",
            baselineRevision: "a".repeat(40),
            targetRevision: "b".repeat(40),
          },
          destination,
        },
        {
          commandRunner,
          snapshotTimeoutMs: 25,
        },
      ),
    ).rejects.toThrow(
      "Repository snapshot preparation timed out after 25 milliseconds.",
    );
  });
});

interface RepositoryFixture {
  remote: string;
  baselineRevision: string;
  baseRevision: string;
  headRevision: string;
  checkoutSpec: PullRequestMergeCheckout;
}

async function createCleanMergeFixture(): Promise<RepositoryFixture> {
  const root = await temporaryDirectory("doxa-snapshot-fixture-");
  const repository = join(root, "source");
  const remote = join(root, "remote.git");
  await git(["init", "--initial-branch=main", repository]);
  await configureIdentity(repository);
  await writeFixtureFile(repository, "README.md", "baseline\n");
  await writeFixtureFile(
    repository,
    "src/rename-me.ts",
    "export const renamed = true;\n",
  );
  await writeFixtureFile(
    repository,
    "src/delete-me.ts",
    "export const deleted = true;\n",
  );
  await writeFixtureFile(
    repository,
    "assets/logo.bin",
    Buffer.from([0, 1, 2, 3]),
  );
  await commitAll(repository, "baseline");
  const baselineRevision = await revision(repository);

  await writeFixtureFile(repository, "base-only.md", "base branch\n");
  await commitAll(repository, "base");
  const baseRevision = await revision(repository);

  await git(["-C", repository, "checkout", "-b", "feature", baselineRevision]);
  await writeFixtureFile(repository, "README.md", "pull request\n");
  await writeFixtureFile(
    repository,
    "assets/logo.bin",
    Buffer.from([4, 5, 6, 7]),
  );
  await git([
    "-C",
    repository,
    "mv",
    "src/rename-me.ts",
    "src/renamed.ts",
  ]);
  await rm(join(repository, "src/delete-me.ts"));
  await commitAll(repository, "pull request");
  const headRevision = await revision(repository);

  await git(["clone", "--bare", repository, remote]);
  await git([
    `--git-dir=${remote}`,
    "update-ref",
    "refs/pull/42/head",
    headRevision,
  ]);

  return {
    remote,
    baselineRevision,
    baseRevision,
    headRevision,
    checkoutSpec: {
      kind: "pull_request_merge",
      pullRequestNumber: 42,
      baselineRevision,
      baseRevision,
      headRevision,
    },
  };
}

async function createConflictFixture(): Promise<RepositoryFixture> {
  const root = await temporaryDirectory("doxa-snapshot-conflict-fixture-");
  const repository = join(root, "source");
  const remote = join(root, "remote.git");
  await git(["init", "--initial-branch=main", repository]);
  await configureIdentity(repository);
  await writeFixtureFile(repository, "conflict.txt", "baseline\n");
  await commitAll(repository, "baseline");
  const baselineRevision = await revision(repository);

  await writeFixtureFile(repository, "conflict.txt", "base branch\n");
  await commitAll(repository, "base");
  const baseRevision = await revision(repository);

  await git(["-C", repository, "checkout", "-b", "feature", baselineRevision]);
  await writeFixtureFile(repository, "conflict.txt", "pull request\n");
  await commitAll(repository, "pull request");
  const headRevision = await revision(repository);

  await git(["clone", "--bare", repository, remote]);
  await git([
    `--git-dir=${remote}`,
    "update-ref",
    "refs/pull/42/head",
    headRevision,
  ]);

  return {
    remote,
    baselineRevision,
    baseRevision,
    headRevision,
    checkoutSpec: {
      kind: "pull_request_merge",
      pullRequestNumber: 42,
      baselineRevision,
      baseRevision,
      headRevision,
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function configureIdentity(repository: string): Promise<void> {
  await git(["-C", repository, "config", "user.name", "Doxa Test"]);
  await git([
    "-C",
    repository,
    "config",
    "user.email",
    "doxa@example.com",
  ]);
}

async function writeFixtureFile(
  repository: string,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const fullPath = join(repository, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
}

async function commitAll(repository: string, message: string): Promise<void> {
  await git(["-C", repository, "add", "--all"]);
  await git(["-C", repository, "commit", "-m", message]);
}

async function revision(repository: string): Promise<string> {
  const { stdout } = await git(["-C", repository, "rev-parse", "HEAD"]);
  return stdout.trim();
}

async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    encoding: "utf8",
  }) as Promise<{ stdout: string; stderr: string }>;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

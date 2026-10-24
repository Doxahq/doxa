import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  repositorySnapshotSchema,
  sourceCheckoutSpecSchema,
  type RepositorySnapshot,
  type SourceChange,
  type SourceCheckoutSpec,
} from "@doxahq/contracts";
import { normalizeSourceChanges } from "@doxahq/generation";
import {
  assertGitAvailable,
  createRepositoryUrl,
  defaultCommandRunner,
  retryGitHubOperation,
  sanitizeToken,
  type CommandRunner,
  type GitHubRetryEvent,
  type GitRetryDelay,
} from "./git";
import {
  createGitCredentialSession,
  type GitCredentialSession,
  type GitCredentialSessionFactory,
} from "./git-credentials";
import { withSnapshotLock } from "./snapshot-lock";

const PREPARED_SNAPSHOT_FILE = "prepared-snapshot.json";
const CONTROL_REPOSITORY_DIRECTORY = "repository.git";
const CHECKOUT_DIRECTORY = "checkout";
const DISABLED_HOOKS_DIRECTORY = "hooks-disabled";
const GIT_COMMAND_TIMEOUT_MS = 120_000;
const EXACT_FETCH_ATTEMPT_TIMEOUT_MS = 10_000;
const SNAPSHOT_PREPARATION_TIMEOUT_MS = 45_000;

export interface PrepareRepositorySnapshotInput {
  repositoryFullName: string;
  installationAccessToken: string;
  checkoutSpec: SourceCheckoutSpec;
  destination: string;
}

export interface PrepareRepositorySnapshotOptions {
  commandRunner?: CommandRunner;
  credentialSessionFactory?: GitCredentialSessionFactory;
  onRetry?: (
    event: RepositorySnapshotRetryEvent,
  ) => Promise<void> | void;
  random?: () => number;
  repositoryUrl?: string;
  retryDelay?: GitRetryDelay;
  signal?: AbortSignal;
  snapshotTimeoutMs?: number;
}

export interface RepositorySnapshotRetryEvent {
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export type PreparedRepositorySnapshotResult =
  | {
      outcome: "prepared";
      checkoutPath: string;
      snapshot: RepositorySnapshot;
    }
  | {
      outcome: "merge_conflict";
      targetRevision: string;
      message: string;
    };

interface PreparedSnapshotMarker {
  repositoryFullName: string;
  checkoutSpec: SourceCheckoutSpec;
  snapshot: RepositorySnapshot;
}

export async function ensureRepositorySnapshot(
  input: PrepareRepositorySnapshotInput,
  options: PrepareRepositorySnapshotOptions = {},
): Promise<PreparedRepositorySnapshotResult> {
  return withSnapshotLock(input.destination, async () => {
    const existing = await readPreparedSnapshot(input, options);
    if (existing) {
      return existing;
    }
    return prepareRepositorySnapshot(input, options);
  });
}

export async function prepareRepositorySnapshot(
  input: PrepareRepositorySnapshotInput,
  options: PrepareRepositorySnapshotOptions = {},
): Promise<PreparedRepositorySnapshotResult> {
  const checkoutSpec = sourceCheckoutSpecSchema.parse(input.checkoutSpec);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const repositoryUrl =
    options.repositoryUrl ?? createRepositoryUrl(input.repositoryFullName);
  const controlRepository = join(
    input.destination,
    CONTROL_REPOSITORY_DIRECTORY,
  );
  const checkoutPath = join(input.destination, CHECKOUT_DIRECTORY);
  const hooksPath = join(input.destination, DISABLED_HOOKS_DIRECTORY);
  const snapshotTimeoutMs = positiveTimeout(
    options.snapshotTimeoutMs,
    SNAPSHOT_PREPARATION_TIMEOUT_MS,
  );
  const deadline = createSnapshotDeadline(
    options.signal,
    snapshotTimeoutMs,
  );
  let credentialSession: GitCredentialSession | undefined;

  try {
    deadline.signal.throwIfAborted();
    credentialSession = await (
      options.credentialSessionFactory ?? createGitCredentialSession
    )(input.installationAccessToken);
    deadline.signal.throwIfAborted();
    await assertGitAvailable(commandRunner, deadline.signal);
    await rm(input.destination, { recursive: true, force: true });
    await Promise.all([
      mkdir(checkoutPath, { recursive: true }),
      mkdir(hooksPath, { recursive: true }),
    ]);
    await runGit(
      commandRunner,
      ["init", "--bare", controlRepository],
      deadline.signal,
    );
    await runGit(
      commandRunner,
      [
        `--git-dir=${controlRepository}`,
        "config",
        "core.hooksPath",
        hooksPath,
      ],
      deadline.signal,
    );
    await runGit(
      commandRunner,
      [
        `--git-dir=${controlRepository}`,
        "remote",
        "add",
        "origin",
        repositoryUrl,
      ],
      deadline.signal,
    );
    await fetchExactRevisions({
      checkoutSpec,
      commandRunner,
      controlRepository,
      credentialEnvironment: credentialSession.environment,
      onRetry: options.onRetry
        ? (retry) =>
            options.onRetry?.({
              attempt: retry.attempt,
              nextAttempt: retry.nextAttempt,
              maxAttempts: retry.maxAttempts,
              delayMs: retry.delayMs,
              reason: sanitizeToken(
                gitFailureMessage(retry.error),
                input.installationAccessToken,
              ),
            })
        : undefined,
      random: options.random,
      retryDelay: options.retryDelay,
      signal: deadline.signal,
    });
    await verifyCleanRemote(
      commandRunner,
      controlRepository,
      repositoryUrl,
      deadline.signal,
    );

    const targetTree = await resolveTargetTree({
      checkoutSpec,
      commandRunner,
      controlRepository,
      credentialEnvironment: credentialSession.environment,
      signal: deadline.signal,
    });
    if (targetTree.outcome === "merge_conflict") {
      return targetTree;
    }

    await materializeTree({
      checkoutPath,
      commandRunner,
      controlRepository,
      credentialEnvironment: credentialSession.environment,
      hooksPath,
      signal: deadline.signal,
      treeHash: targetTree.treeHash,
    });
    const changes = await readSourceChanges({
      baselineReference: "refs/doxa/baseline",
      commandRunner,
      controlRepository,
      credentialEnvironment: credentialSession.environment,
      signal: deadline.signal,
      targetTreeHash: targetTree.treeHash,
    });
    const snapshot = repositorySnapshotSchema.parse({
      targetRevision: targetRevision(checkoutSpec),
      sourceTreeHash: targetTree.treeHash,
      changes,
    });
    const marker: PreparedSnapshotMarker = {
      repositoryFullName: input.repositoryFullName,
      checkoutSpec,
      snapshot,
    };
    await writeFile(
      join(input.destination, PREPARED_SNAPSHOT_FILE),
      `${JSON.stringify(marker)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    return {
      outcome: "prepared",
      checkoutPath,
      snapshot,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (deadline.didTimeout()) {
      throw new Error(
        `Repository snapshot preparation timed out after ${formatDuration(snapshotTimeoutMs)}.`,
      );
    }
    throw new Error(
      sanitizeToken(gitFailureMessage(error), input.installationAccessToken),
    );
  } finally {
    deadline.dispose();
    await credentialSession?.dispose();
  }
}

async function readPreparedSnapshot(
  input: PrepareRepositorySnapshotInput,
  options: PrepareRepositorySnapshotOptions,
): Promise<PreparedRepositorySnapshotResult | null> {
  const markerPath = join(input.destination, PREPARED_SNAPSHOT_FILE);
  const checkoutPath = join(input.destination, CHECKOUT_DIRECTORY);
  const controlRepository = join(
    input.destination,
    CONTROL_REPOSITORY_DIRECTORY,
  );
  try {
    const raw = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    const marker = parsePreparedSnapshotMarker(raw);
    if (
      marker.repositoryFullName !== input.repositoryFullName ||
      !sameCheckoutSpec(marker.checkoutSpec, input.checkoutSpec)
    ) {
      return null;
    }
    await access(checkoutPath);
    await verifyMaterializedTree({
      checkoutPath,
      commandRunner: options.commandRunner ?? defaultCommandRunner,
      controlRepository,
      signal: options.signal,
      treeHash: marker.snapshot.sourceTreeHash,
    });
    return {
      outcome: "prepared",
      checkoutPath,
      snapshot: marker.snapshot,
    };
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

function parsePreparedSnapshotMarker(value: unknown): PreparedSnapshotMarker {
  if (!isRecord(value)) {
    throw new Error("Prepared repository snapshot marker is invalid.");
  }
  return {
    repositoryFullName: requiredString(value.repositoryFullName),
    checkoutSpec: sourceCheckoutSpecSchema.parse(value.checkoutSpec),
    snapshot: repositorySnapshotSchema.parse(value.snapshot),
  };
}

async function fetchExactRevisions(input: {
  checkoutSpec: SourceCheckoutSpec;
  commandRunner: CommandRunner;
  controlRepository: string;
  credentialEnvironment: NodeJS.ProcessEnv;
  onRetry?: (event: GitHubRetryEvent) => Promise<void> | void;
  random?: () => number;
  retryDelay?: GitRetryDelay;
  signal?: AbortSignal;
}): Promise<void> {
  const refspecs = [
    `+${input.checkoutSpec.baselineRevision}:refs/doxa/baseline`,
  ];
  if (input.checkoutSpec.kind === "pull_request_merge") {
    refspecs.push(
      `+${input.checkoutSpec.baseRevision}:refs/doxa/base`,
      `+refs/pull/${input.checkoutSpec.pullRequestNumber}/head:refs/doxa/head`,
    );
  } else {
    refspecs.push(
      `+${input.checkoutSpec.targetRevision}:refs/doxa/target`,
    );
  }

  await retryGitHubOperation(
    () =>
      runGit(
        input.commandRunner,
        [
          `--git-dir=${input.controlRepository}`,
          "fetch",
          "--force",
          "--no-tags",
          "--filter=blob:none",
          "origin",
          ...refspecs,
        ],
        input.signal,
        input.credentialEnvironment,
        EXACT_FETCH_ATTEMPT_TIMEOUT_MS,
      ),
    {
      onRetry: input.onRetry,
      random: input.random,
      retryDelay: input.retryDelay,
      signal: input.signal,
    },
  );

  if (input.checkoutSpec.kind === "pull_request_merge") {
    const fetchedHead = await resolveObjectId(
      input.commandRunner,
      input.controlRepository,
      "refs/doxa/head",
      input.signal,
    );
    if (fetchedHead !== input.checkoutSpec.headRevision) {
      throw new Error(
        "The fetched pull-request head no longer matches the accepted revision.",
      );
    }
  }
}

async function resolveTargetTree(input: {
  checkoutSpec: SourceCheckoutSpec;
  commandRunner: CommandRunner;
  controlRepository: string;
  credentialEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<
  | { outcome: "prepared"; treeHash: string }
  | Extract<PreparedRepositorySnapshotResult, { outcome: "merge_conflict" }>
> {
  if (input.checkoutSpec.kind === "commit") {
    return {
      outcome: "prepared",
      treeHash: await resolveObjectId(
        input.commandRunner,
        input.controlRepository,
        "refs/doxa/target^{tree}",
        input.signal,
      ),
    };
  }

  try {
    const result = await runGit(
      input.commandRunner,
      [
        `--git-dir=${input.controlRepository}`,
        "merge-tree",
        "--write-tree",
        "refs/doxa/base",
        "refs/doxa/head",
      ],
      input.signal,
      input.credentialEnvironment,
    );
    return {
      outcome: "prepared",
      treeHash: parseObjectId(result.stdout),
    };
  } catch (error) {
    const treeHash = mergeConflictTreeHash(error);
    if (!treeHash) {
      throw error;
    }
    return {
      outcome: "merge_conflict",
      targetRevision: input.checkoutSpec.headRevision,
      message:
        "The pull request cannot be merged cleanly with its accepted base revision.",
    };
  }
}

async function materializeTree(input: {
  checkoutPath: string;
  commandRunner: CommandRunner;
  controlRepository: string;
  credentialEnvironment: NodeJS.ProcessEnv;
  hooksPath: string;
  signal?: AbortSignal;
  treeHash: string;
}): Promise<void> {
  await runGit(
    input.commandRunner,
    [
      "-c",
      `core.hooksPath=${input.hooksPath}`,
      `--git-dir=${input.controlRepository}`,
      `--work-tree=${input.checkoutPath}`,
      "read-tree",
      "--reset",
      "-u",
      input.treeHash,
    ],
    input.signal,
    input.credentialEnvironment,
  );
}

async function readSourceChanges(input: {
  baselineReference: string;
  commandRunner: CommandRunner;
  controlRepository: string;
  credentialEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  targetTreeHash: string;
}): Promise<SourceChange[]> {
  const result = await runGit(
    input.commandRunner,
    [
      `--git-dir=${input.controlRepository}`,
      "diff",
      "--name-status",
      "-z",
      "-M",
      input.baselineReference,
      input.targetTreeHash,
    ],
    input.signal,
    input.credentialEnvironment,
  );
  return normalizeSourceChanges(parseNameStatus(result.stdout));
}

export function parseNameStatus(output: string): SourceChange[] {
  if (output.length === 0) {
    return [];
  }
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }

  const changes: SourceChange[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    if (/^R\d{1,3}$/.test(status)) {
      const previousPath = fields[index];
      const path = fields[index + 1];
      if (!previousPath || !path) {
        throw new Error("Git returned incomplete rename metadata.");
      }
      changes.push({ path, previousPath, status: "renamed" });
      index += 2;
      continue;
    }

    const path = fields[index];
    if (!path) {
      throw new Error("Git returned incomplete source change metadata.");
    }
    changes.push({ path, status: mapChangeStatus(status) });
    index += 1;
  }
  return changes;
}

function mapChangeStatus(status: string): SourceChange["status"] {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T":
      return "modified";
    default:
      throw new Error(`Git returned unsupported source change status ${status}.`);
  }
}

async function verifyCleanRemote(
  commandRunner: CommandRunner,
  controlRepository: string,
  expectedUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit(
    commandRunner,
    [
      `--git-dir=${controlRepository}`,
      "remote",
      "get-url",
      "origin",
    ],
    signal,
  );
  if (result.stdout.trim() !== expectedUrl) {
    throw new Error("Git remote verification failed.");
  }
}

async function verifyMaterializedTree(input: {
  checkoutPath: string;
  commandRunner: CommandRunner;
  controlRepository: string;
  signal?: AbortSignal;
  treeHash: string;
}): Promise<void> {
  await runGit(
    input.commandRunner,
    [
      `--git-dir=${input.controlRepository}`,
      `--work-tree=${input.checkoutPath}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--quiet",
      input.treeHash,
      "--",
    ],
    input.signal,
  );
  const untrackedFiles = await runGit(
    input.commandRunner,
    [
      `--git-dir=${input.controlRepository}`,
      `--work-tree=${input.checkoutPath}`,
      "ls-files",
      "--others",
      "--exclude-standard",
    ],
    input.signal,
  );
  if (untrackedFiles.stdout.length > 0) {
    throw new Error("Prepared repository checkout was modified.");
  }
}

async function resolveObjectId(
  commandRunner: CommandRunner,
  controlRepository: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(
    commandRunner,
    [
      `--git-dir=${controlRepository}`,
      "rev-parse",
      "--verify",
      revision,
    ],
    signal,
  );
  return parseObjectId(result.stdout);
}

async function runGit(
  commandRunner: CommandRunner,
  args: string[],
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
  timeoutMs = GIT_COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  return commandRunner("git", args, {
    timeout: timeoutMs,
    ...(environment ? { env: environment } : {}),
    ...(signal ? { signal } : {}),
  });
}

function createSnapshotDeadline(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener(
      "abort",
      abortFromExternalSignal,
      { once: true },
    );
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new Error(
        `Repository snapshot preparation timed out after ${formatDuration(timeoutMs)}.`,
      ),
    );
  }, timeoutMs);
  timeout.unref();

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener(
        "abort",
        abortFromExternalSignal,
      );
    },
  };
}

function positiveTimeout(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${milliseconds} milliseconds`;
  }
  return `${milliseconds / 1_000} seconds`;
}

function parseObjectId(value: string): string {
  const objectId = value.trim().split(/\s+/, 1)[0];
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
    throw new Error("Git returned an invalid object ID.");
  }
  return objectId;
}

function mergeConflictTreeHash(error: unknown): string | null {
  if (!isRecord(error) || error.code !== 1 || typeof error.stdout !== "string") {
    return null;
  }
  try {
    return parseObjectId(error.stdout);
  } catch {
    return null;
  }
}

function targetRevision(checkoutSpec: SourceCheckoutSpec): string {
  return checkoutSpec.kind === "pull_request_merge"
    ? checkoutSpec.headRevision
    : checkoutSpec.targetRevision;
}

function sameCheckoutSpec(
  left: SourceCheckoutSpec,
  right: SourceCheckoutSpec,
): boolean {
  return JSON.stringify(left) === JSON.stringify(
    sourceCheckoutSpecSchema.parse(right),
  );
}

function gitFailureMessage(error: unknown): string {
  const messages: string[] = [];
  if (error instanceof Error && error.message) {
    messages.push(error.message);
  }
  if (isRecord(error)) {
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      messages.push(error.stdout.trim());
    }
    if (typeof error.stderr === "string" && error.stderr.trim()) {
      messages.push(error.stderr.trim());
    }
  }
  return [...new Set(messages)].join("\n") || "Git snapshot preparation failed.";
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Prepared repository snapshot marker is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

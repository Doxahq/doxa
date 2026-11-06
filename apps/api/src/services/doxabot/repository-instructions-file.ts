import {
  DOXABOT_INSTRUCTION_LIMITS,
  DOXABOT_REPOSITORY_INSTRUCTIONS_PATH,
  REPOSITORY_INSTRUCTIONS_REFUSED_MESSAGE,
  REPOSITORY_INSTRUCTIONS_UNAVAILABLE_MESSAGE,
  cleanInstructionText,
  isOutOfScopeInstructionText,
  type GenerationRepositoryInstructionsFile,
} from "@doxahq/contracts";
import type { RepositoryReadAccess } from "../repository-read-access";
import { GITHUB_API_BASE_URL, githubApiHeaders } from "./github-api";
import { isGitHubRateLimited } from "../github-rate-limit";

/** Larger files are not instructions; the run skips them without reading them all. */
const MAX_FILE_BYTES = 64 * 1024;

/** How often a run asks GitHub for the file before it gives up. */
const READ_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1_000] as const;
/**
 * The longest one request may take. Three attempts and their waits stay
 * well inside the two minutes that the worker gives the context step.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * GitHub did not give the file, so the run cannot know what it says. The run
 * stops instead of going on without the file: the file is part of the
 * instructions fingerprint, and one failed read would otherwise rewrite
 * every page twice, once without the file and once with it.
 */
export class RepositoryInstructionsUnavailableError extends Error {
  constructor(cause?: unknown, message: string = REPOSITORY_INSTRUCTIONS_UNAVAILABLE_MESSAGE) {
    super(message, { cause });
    this.name = "RepositoryInstructionsUnavailableError";
  }
}

/**
 * GitHub refused the read, so trying again cannot help. Its message is the
 * contract's refused message, which the worker matches after the service
 * binding drops the class, to stop the run without retries.
 */
export class RepositoryInstructionsRefusedError extends RepositoryInstructionsUnavailableError {
  constructor(cause?: unknown) {
    super(cause, REPOSITORY_INSTRUCTIONS_REFUSED_MESSAGE);
    this.name = "RepositoryInstructionsRefusedError";
  }
}

export interface RepositoryInstructionsReadOptions {
  fetchRequest?: typeof fetch;
  /** Waits between attempts; tests pass one that resolves at once. */
  wait?: (ms: number) => Promise<void>;
}

/** One answer from GitHub: the file as the run sees it, or why to try again or stop. */
type ReadAttempt =
  | { outcome: "file"; file: GenerationRepositoryInstructionsFile }
  | { outcome: "retry"; failure: unknown }
  | { outcome: "refused"; failure: unknown };

/**
 * Reads `.doxa/instructions.md` from the default branch through the GitHub
 * API. The file never comes from a pull request, so a contributor cannot
 * change Doxabot's instructions by opening one.
 *
 * Only two answers are stable: the file, and 404 (no file). A network error,
 * a timeout, a rate limit, a server error or a body that does not arrive is
 * retried, and so is a 403 that GitHub marks as a rate limit. A refusal, such
 * as 401 or another 403, throws {@link RepositoryInstructionsRefusedError} at
 * once. When no stable answer comes, the read throws
 * {@link RepositoryInstructionsUnavailableError}. Either way a failure never
 * enters the fingerprint as a different file.
 */
export async function readRepositoryInstructionsFile(
  access: RepositoryReadAccess,
  options: RepositoryInstructionsReadOptions = {},
): Promise<GenerationRepositoryInstructionsFile> {
  const fetchRequest = options.fetchRequest ?? fetch;
  const wait = options.wait ?? delay;
  let lastFailure: unknown;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    const result = await readOnce(access, fetchRequest);
    if (result.outcome === "file") return result.file;
    if (result.outcome === "refused") throw new RepositoryInstructionsRefusedError(result.failure);
    lastFailure = result.failure;
  }
  throw new RepositoryInstructionsUnavailableError(lastFailure);
}

async function readOnce(access: RepositoryReadAccess, fetchRequest: typeof fetch): Promise<ReadAttempt> {
  let response: Response;
  try {
    response = await fetchRequest(fileUrl(access), {
      method: "GET",
      headers: { ...githubApiHeaders(access.token), accept: "application/vnd.github.raw+json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { outcome: "retry", failure: error };
  }
  if (response.status === 404) return { outcome: "file", file: { status: "missing" } };
  if (!response.ok) {
    const failure = new Error(`GitHub answered ${response.status}.`);
    return isTransientStatus(response.status) || await isGitHubRateLimited(response)
      ? { outcome: "retry", failure }
      : { outcome: "refused", failure };
  }
  try {
    return { outcome: "file", file: await toFileResult(response) };
  } catch (error) {
    return { outcome: "retry", failure: error };
  }
}

function fileUrl(access: RepositoryReadAccess): string {
  const { owner, name, defaultBranch } = access.target;
  return `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    + `/contents/${DOXABOT_REPOSITORY_INSTRUCTIONS_PATH}?ref=${encodeURIComponent(defaultBranch)}`;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The file of a successful answer. Throws when the body does not arrive. */
async function toFileResult(response: Response): Promise<GenerationRepositoryInstructionsFile> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) return { status: "unreadable", reason: "too_long" };

  return toInstructionsFile(bytes);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exported for tests: turns raw file bytes into the run's view of the file. */
export function toInstructionsFile(bytes: Uint8Array): GenerationRepositoryInstructionsFile {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { status: "unreadable", reason: "not_text" };
  }

  const text = cleanInstructionText(raw);
  if (!text) return { status: "missing" };
  if (text.length > DOXABOT_INSTRUCTION_LIMITS.repositoryFileLength) {
    return { status: "unreadable", reason: "too_long" };
  }
  return { status: "found", text, flagged: isOutOfScopeInstructionText(text) };
}

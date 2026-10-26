import {
  DOXABOT_INSTRUCTION_LIMITS,
  DOXABOT_REPOSITORY_INSTRUCTIONS_PATH,
  cleanInstructionText,
  isOutOfScopeInstructionText,
  type GenerationRepositoryInstructionsFile,
} from "@doxahq/contracts";
import type { RepositoryReadAccess } from "../repository-read-access";
import { GITHUB_API_BASE_URL, githubApiHeaders } from "./github-api";

/** Larger files are not instructions; the run skips them without reading them all. */
const MAX_FILE_BYTES = 64 * 1024;

/**
 * Reads `.doxa/instructions.md` from the default branch through the GitHub
 * API. The file never comes from a pull request, so a contributor cannot
 * change Doxabot's instructions by opening one. A failure never stops a run:
 * the result says why the file was skipped.
 */
export async function readRepositoryInstructionsFile(
  access: RepositoryReadAccess,
  fetchRequest: typeof fetch = fetch,
): Promise<GenerationRepositoryInstructionsFile> {
  const { owner, name, defaultBranch } = access.target;
  const url = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    + `/contents/${DOXABOT_REPOSITORY_INSTRUCTIONS_PATH}?ref=${encodeURIComponent(defaultBranch)}`;

  let response: Response;
  try {
    response = await fetchRequest(url, {
      method: "GET",
      headers: { ...githubApiHeaders(access.token), accept: "application/vnd.github.raw+json" },
    });
  } catch {
    return { status: "unreadable", reason: "request_failed" };
  }

  if (response.status === 404) return { status: "missing" };
  if (!response.ok) return { status: "unreadable", reason: "request_failed" };

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) return { status: "unreadable", reason: "too_long" };

  return toInstructionsFile(bytes);
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

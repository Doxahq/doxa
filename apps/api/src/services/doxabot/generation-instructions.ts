import type {
  GenerationContext,
  GenerationInstructions,
  GenerationRepositoryInstructionsFile,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { ProjectInstructionVersion } from "../../repositories/project-instructions";
import { isLostInstallationAccess } from "../github-app";
import {
  createRepositoryReadAccess,
  NoConnectedRepositoryError,
  type RepositoryReadAccess,
} from "../repository-read-access";
import { DoxabotInstructionsService } from "./instructions";
import {
  readRepositoryInstructionsFile,
  RepositoryInstructionsRefusedError,
  RepositoryInstructionsUnavailableError,
} from "./repository-instructions-file";

export interface GenerationInstructionsSources {
  getCurrent(projectId: string): Promise<ProjectInstructionVersion | null>;
  readRepositoryFile(projectId: string): Promise<GenerationRepositoryInstructionsFile>;
}

export function generationInstructionsSourcesFromEnv(env: Env): GenerationInstructionsSources {
  const service = DoxabotInstructionsService.fromEnv(env);
  return {
    getCurrent: (projectId) => service.getCurrent(projectId),
    readRepositoryFile: async (projectId) =>
      readRepositoryInstructionsFile(await repositoryAccessForInstructions(() => createRepositoryReadAccess(env, projectId))),
  };
}

/** How long to wait before asking once more for access that GitHub refused. */
const REFUSAL_RECHECK_DELAY_MS = 2_000;

export interface RepositoryAccessOptions {
  /** Waits between the two asks; tests pass a stub. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Read access for the instructions file. Without it the run cannot read the
 * code either. A project with no connected repository is a refusal at once.
 * A lost installation is a refusal only when a second ask, after a short
 * wait, gets the same answer, so a short GitHub incident is not taken for an
 * uninstall. Any other failure may pass, so it is retried as unavailable.
 */
export async function repositoryAccessForInstructions(
  createAccess: () => Promise<RepositoryReadAccess>,
  options: RepositoryAccessOptions = {},
): Promise<RepositoryReadAccess> {
  try {
    return await createAccess();
  } catch (error) {
    if (!isLostInstallationAccess(error)) throw classifyAccessFailure(error);
  }
  await (options.wait ?? delay)(REFUSAL_RECHECK_DELAY_MS);
  try {
    return await createAccess();
  } catch (error) {
    throw classifyAccessFailure(error);
  }
}

function classifyAccessFailure(error: unknown): Error {
  return isLostInstallationAccess(error) || error instanceof NoConnectedRepositoryError
    ? new RepositoryInstructionsRefusedError(error)
    : new RepositoryInstructionsUnavailableError(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The instructions one run follows, or null when the project has none. */
export async function loadGenerationInstructions(
  sources: GenerationInstructionsSources,
  projectId: string,
): Promise<GenerationInstructions | null> {
  const current = await sources.getCurrent(projectId);
  if (!current) return null;

  const repositoryFile = current.instructions.repositoryFile.enabled
    ? await sources.readRepositoryFile(projectId)
    : { status: "disabled" as const };

  return {
    version: current.version,
    instructions: current.instructions,
    screening: current.screening,
    repositoryFile,
  };
}

/** Adds the project's Doxabot instructions to a generation context. */
export async function withDoxabotInstructions<T extends GenerationContext>(
  env: Env,
  context: T | null,
  sources: GenerationInstructionsSources = generationInstructionsSourcesFromEnv(env),
): Promise<T | null> {
  if (!context) return null;
  return {
    ...context,
    doxabotInstructions: await loadGenerationInstructions(sources, context.project.id),
  };
}

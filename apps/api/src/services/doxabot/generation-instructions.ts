import type {
  GenerationContext,
  GenerationInstructions,
  GenerationRepositoryInstructionsFile,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { ProjectInstructionVersion } from "../../repositories/project-instructions";
import { createRepositoryReadAccess } from "../repository-read-access";
import { DoxabotInstructionsService } from "./instructions";
import { readRepositoryInstructionsFile } from "./repository-instructions-file";

export interface GenerationInstructionsSources {
  getCurrent(projectId: string): Promise<ProjectInstructionVersion | null>;
  readRepositoryFile(projectId: string): Promise<GenerationRepositoryInstructionsFile>;
}

export function generationInstructionsSourcesFromEnv(env: Env): GenerationInstructionsSources {
  const service = DoxabotInstructionsService.fromEnv(env);
  return {
    getCurrent: (projectId) => service.getCurrent(projectId),
    readRepositoryFile: async (projectId) => {
      try {
        return await readRepositoryInstructionsFile(await createRepositoryReadAccess(env, projectId));
      } catch {
        // A token or lookup failure must not stop the run.
        return { status: "unreadable", reason: "request_failed" };
      }
    },
  };
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

import {
  screenDoxabotInstructions,
  type DoxabotInstructionScreening,
  type DoxabotInstructions,
  type DoxabotInstructionsState,
  type DoxabotInstructionsVersion,
  type DoxabotInstructionsVersionSummary,
} from "@doxahq/contracts";
import type { DbEnv } from "@doxahq/db";
import {
  InstructionVersionTakenError,
  ProjectInstructionsRepository,
  type ProjectInstructionVersion,
  type ProjectInstructionVersionSummary,
  type ProjectInstructionsStore,
} from "../../repositories/project-instructions";

/** How many versions the history shows. Older rows stay stored. */
export const INSTRUCTIONS_HISTORY_LIMIT = 20;

/**
 * Flags free text that asks for more than style or content. Async, so a
 * model-based screener can replace the heuristic one without a new interface.
 */
export type InstructionScreener = (
  instructions: Pick<DoxabotInstructions, "rules" | "context">,
) => DoxabotInstructionScreening | Promise<DoxabotInstructionScreening>;

export type DoxabotInstructionsErrorCode = "stale_version" | "version_not_found";

export class DoxabotInstructionsError extends Error {
  constructor(readonly code: DoxabotInstructionsErrorCode, message: string) {
    super(message);
    this.name = "DoxabotInstructionsError";
  }
}

interface VersionWrite {
  projectId: string;
  /** The version the editor loaded; null when the project had none. */
  baseVersion: number | null;
  actorUserId: string;
}

export class DoxabotInstructionsService {
  constructor(
    private readonly store: ProjectInstructionsStore,
    private readonly screen: InstructionScreener = screenDoxabotInstructions,
  ) {}

  static fromEnv(env: DbEnv): DoxabotInstructionsService {
    return new DoxabotInstructionsService(new ProjectInstructionsRepository(env));
  }

  /** The saved version that generations use, or null before the first save. */
  getCurrent(projectId: string): Promise<ProjectInstructionVersion | null> {
    return this.store.getLatest(projectId);
  }

  async getState(projectId: string): Promise<DoxabotInstructionsState> {
    const [current, history] = await Promise.all([
      this.store.getLatest(projectId),
      this.store.listVersions(projectId, INSTRUCTIONS_HISTORY_LIMIT),
    ]);
    return {
      current: current ? toVersionDto(current) : null,
      history: history.map(toSummaryDto),
    };
  }

  async save(input: VersionWrite & { instructions: DoxabotInstructions }): Promise<DoxabotInstructionsState> {
    await this.writeVersion(input, input.instructions);
    return this.getState(input.projectId);
  }

  /** Saves an older version again as the newest one, so the history keeps both. */
  async restore(input: VersionWrite & { version: number }): Promise<DoxabotInstructionsState> {
    const restored = await this.store.getVersion(input.projectId, input.version);
    if (!restored) {
      throw new DoxabotInstructionsError("version_not_found", `Instructions version ${input.version} does not exist.`);
    }
    await this.writeVersion(input, restored.instructions);
    return this.getState(input.projectId);
  }

  private async writeVersion(write: VersionWrite, instructions: DoxabotInstructions): Promise<void> {
    const latest = await this.store.getLatest(write.projectId);
    const latestVersion = latest?.version ?? null;
    if (latestVersion !== write.baseVersion) throw staleVersionError();

    try {
      await this.store.insertVersion({
        projectId: write.projectId,
        version: (latestVersion ?? 0) + 1,
        instructions,
        // Screened again on restore too, so an older version meets today's checks.
        screening: await this.screen(instructions),
        createdByUserId: write.actorUserId,
      });
    } catch (caught) {
      if (caught instanceof InstructionVersionTakenError) throw staleVersionError();
      throw caught;
    }
  }
}

function staleVersionError(): DoxabotInstructionsError {
  return new DoxabotInstructionsError(
    "stale_version",
    "Someone saved newer instructions. Reload the page to see them.",
  );
}

function toSummaryDto(summary: ProjectInstructionVersionSummary): DoxabotInstructionsVersionSummary {
  return {
    version: summary.version,
    createdAt: summary.createdAt.toISOString(),
    createdBy: summary.createdBy,
  };
}

function toVersionDto(version: ProjectInstructionVersion): DoxabotInstructionsVersion {
  return {
    ...toSummaryDto(version),
    instructions: version.instructions,
    screening: version.screening,
  };
}

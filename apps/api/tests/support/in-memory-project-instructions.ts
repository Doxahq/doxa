import {
  InstructionVersionTakenError,
  type NewProjectInstructionVersion,
  type ProjectInstructionVersion,
  type ProjectInstructionVersionSummary,
  type ProjectInstructionsStore,
} from "../../src/repositories/project-instructions";

/** A `ProjectInstructionsStore` that keeps rows in memory, with the unique (project, version) rule. */
export class InMemoryProjectInstructionsStore implements ProjectInstructionsStore {
  readonly rows: ProjectInstructionVersion[] = [];
  private readonly projectOf = new WeakMap<ProjectInstructionVersion, string>();

  constructor(private readonly now: () => Date = () => new Date("2026-10-25T12:00:00Z")) {}

  async getLatest(projectId: string): Promise<ProjectInstructionVersion | null> {
    return this.forProject(projectId).at(0) ?? null;
  }

  async getVersion(projectId: string, version: number): Promise<ProjectInstructionVersion | null> {
    return this.forProject(projectId).find((row) => row.version === version) ?? null;
  }

  async listVersions(projectId: string, limit: number): Promise<ProjectInstructionVersionSummary[]> {
    return this.forProject(projectId)
      .slice(0, limit)
      .map(({ version, createdAt, createdBy }) => ({ version, createdAt, createdBy }));
  }

  async insertVersion(input: NewProjectInstructionVersion): Promise<ProjectInstructionVersion> {
    if (this.forProject(input.projectId).some((row) => row.version === input.version)) {
      throw new InstructionVersionTakenError(input.version);
    }
    const row: ProjectInstructionVersion = {
      version: input.version,
      instructions: input.instructions,
      screening: input.screening,
      createdAt: this.now(),
      createdBy: { id: input.createdByUserId, name: null },
    };
    this.projectOf.set(row, input.projectId);
    this.rows.push(row);
    return row;
  }

  /** Newest first. */
  private forProject(projectId: string): ProjectInstructionVersion[] {
    return this.rows
      .filter((row) => this.projectOf.get(row) === projectId)
      .sort((a, b) => b.version - a.version);
  }
}

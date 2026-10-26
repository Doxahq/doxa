import {
  doxabotInstructionScreeningSchema,
  doxabotInstructionsSchema,
  type DoxabotInstructionScreening,
  type DoxabotInstructions,
} from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, desc, eq } from "drizzle-orm";
import { isUniqueViolation } from "./postgres-errors";

const PROJECT_VERSION_INDEX = "project_instruction_versions_project_version_idx";
const versions = schema.projectInstructionVersions;

export interface InstructionAuthor {
  id: string;
  name: string | null;
}

export interface ProjectInstructionVersionSummary {
  version: number;
  createdAt: Date;
  createdBy: InstructionAuthor | null;
}

export interface ProjectInstructionVersion extends ProjectInstructionVersionSummary {
  instructions: DoxabotInstructions;
  screening: DoxabotInstructionScreening;
}

export interface NewProjectInstructionVersion {
  projectId: string;
  version: number;
  instructions: DoxabotInstructions;
  screening: DoxabotInstructionScreening;
  createdByUserId: string;
}

/** Another save took this version number first. */
export class InstructionVersionTakenError extends Error {
  constructor(readonly version: number) {
    super(`Instructions version ${version} already exists.`);
    this.name = "InstructionVersionTakenError";
  }
}

export interface ProjectInstructionsStore {
  getLatest(projectId: string): Promise<ProjectInstructionVersion | null>;
  getVersion(projectId: string, version: number): Promise<ProjectInstructionVersion | null>;
  /** Newest first. */
  listVersions(projectId: string, limit: number): Promise<ProjectInstructionVersionSummary[]>;
  /** Throws `InstructionVersionTakenError` when the number is already used. */
  insertVersion(input: NewProjectInstructionVersion): Promise<ProjectInstructionVersion>;
}

export class ProjectInstructionsRepository implements ProjectInstructionsStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getLatest(projectId: string): Promise<ProjectInstructionVersion | null> {
    const [row] = await this.selectVersions()
      .where(eq(versions.projectId, projectId))
      .orderBy(desc(versions.version))
      .limit(1);
    return row ? toVersion(row) : null;
  }

  async getVersion(projectId: string, version: number): Promise<ProjectInstructionVersion | null> {
    const [row] = await this.selectVersions()
      .where(and(eq(versions.projectId, projectId), eq(versions.version, version)))
      .limit(1);
    return row ? toVersion(row) : null;
  }

  async listVersions(projectId: string, limit: number): Promise<ProjectInstructionVersionSummary[]> {
    const rows = await this.db
      .select({
        version: versions.version,
        createdAt: versions.createdAt,
        authorId: schema.user.id,
        authorName: schema.user.name,
      })
      .from(versions)
      .leftJoin(schema.user, eq(schema.user.id, versions.createdByUserId))
      .where(eq(versions.projectId, projectId))
      .orderBy(desc(versions.version))
      .limit(limit);
    return rows.map(toSummary);
  }

  async insertVersion(input: NewProjectInstructionVersion): Promise<ProjectInstructionVersion> {
    try {
      await this.db.insert(versions).values({
        projectId: input.projectId,
        version: input.version,
        body: doxabotInstructionsSchema.parse(input.instructions),
        screening: doxabotInstructionScreeningSchema.parse(input.screening),
        createdByUserId: input.createdByUserId,
      });
    } catch (caught) {
      if (isUniqueViolation(caught, PROJECT_VERSION_INDEX)) {
        throw new InstructionVersionTakenError(input.version);
      }
      throw caught;
    }

    const saved = await this.getVersion(input.projectId, input.version);
    if (!saved) throw new Error(`Instructions version ${input.version} was not saved.`);
    return saved;
  }

  private selectVersions() {
    return this.db
      .select({
        version: versions.version,
        body: versions.body,
        screening: versions.screening,
        createdAt: versions.createdAt,
        authorId: schema.user.id,
        authorName: schema.user.name,
      })
      .from(versions)
      .leftJoin(schema.user, eq(schema.user.id, versions.createdByUserId));
  }
}


interface SummaryRow {
  version: number;
  createdAt: Date;
  authorId: string | null;
  authorName: string | null;
}

interface VersionRow extends SummaryRow {
  body: unknown;
  screening: unknown;
}

function toSummary(row: SummaryRow): ProjectInstructionVersionSummary {
  return {
    version: row.version,
    createdAt: row.createdAt,
    createdBy: row.authorId ? { id: row.authorId, name: row.authorName } : null,
  };
}

function toVersion(row: VersionRow): ProjectInstructionVersion {
  return {
    ...toSummary(row),
    instructions: doxabotInstructionsSchema.parse(row.body),
    screening: doxabotInstructionScreeningSchema.parse(row.screening),
  };
}

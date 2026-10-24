import type { TeamRole } from "@doxahq/contracts/teams";
import { asc, eq, inArray } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";

export interface EmailContact {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

export interface ProjectMember extends EmailContact {
  readonly role: TeamRole;
}

export interface ProjectAudience {
  readonly projectName: string;
  /** The team's members, or the owner alone (role `owner`) for a personal project. */
  readonly members: readonly ProjectMember[];
}

export interface GenerationAudience {
  readonly projectId: string;
  readonly projectName: string;
  /** Null for a Doxabot run without a linked author. */
  readonly requester: EmailContact | null;
}

/** Who can get an email about a project, a generation, or a request. */
export interface EmailAudience {
  projectAudience(projectId: string): Promise<ProjectAudience | null>;
  contactsFor(userIds: readonly string[]): Promise<ReadonlyMap<string, EmailContact>>;
  generationAudience(jobId: string): Promise<GenerationAudience | null>;
}

const { projects, teamMembers, user, generationJobs } = schema;

export class EmailAudienceRepository implements EmailAudience {
  constructor(private readonly db: DoxaDb) {}

  static fromEnv(env: DbEnv): EmailAudienceRepository {
    return new EmailAudienceRepository(createDb(env));
  }

  async projectAudience(projectId: string): Promise<ProjectAudience | null> {
    const [project] = await this.db
      .select({ name: projects.name, ownerUserId: projects.userId, teamId: projects.teamId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return null;

    if (project.teamId === null) {
      const owner = (await this.contactsFor([project.ownerUserId])).get(project.ownerUserId);
      return { projectName: project.name, members: owner ? [{ ...owner, role: "owner" }] : [] };
    }
    const members = await this.db
      .select({ userId: teamMembers.userId, name: user.name, email: user.email, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(user, eq(user.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, project.teamId))
      .orderBy(asc(teamMembers.createdAt));
    return { projectName: project.name, members };
  }

  async contactsFor(userIds: readonly string[]): Promise<ReadonlyMap<string, EmailContact>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ userId: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, unique));
    return new Map(rows.map((row) => [row.userId, row]));
  }

  async generationAudience(jobId: string): Promise<GenerationAudience | null> {
    const [row] = await this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        requesterId: user.id,
        requesterName: user.name,
        requesterEmail: user.email,
      })
      .from(generationJobs)
      .innerJoin(projects, eq(projects.id, generationJobs.projectId))
      .leftJoin(user, eq(user.id, generationJobs.requestedByUserId))
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    if (!row) return null;
    const requester =
      row.requesterId && row.requesterName !== null && row.requesterEmail !== null
        ? { userId: row.requesterId, name: row.requesterName, email: row.requesterEmail }
        : null;
    return { projectId: row.projectId, projectName: row.projectName, requester };
  }
}

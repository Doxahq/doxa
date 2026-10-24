import { inArray } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";

/** Display names of users, so a team sees who asked and who decided. */
export interface UserDirectory {
  /** Unknown IDs are left out of the map. */
  namesFor(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export class UserDirectoryRepository implements UserDirectory {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async namesFor(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(inArray(schema.user.id, unique));
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

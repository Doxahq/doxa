import { createDb, schema } from "@doxahq/db";
import type { Env } from "../env";

export async function ensureLocalDevUser(env: Env, userId: string): Promise<void> {
  const db = createDb(env);
  const now = new Date();

  await db
    .insert(schema.user)
    .values({
      id: userId,
      name: "Local Dev",
      email: "local-dev@doxa.local",
      emailVerified: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.user.id,
      set: {
        name: "Local Dev",
        emailVerified: true,
        updatedAt: now,
      },
    });
}

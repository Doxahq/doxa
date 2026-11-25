import { eq } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import type { PrivacySettingsStore } from "../services/privacy/privacy-settings-store";

const { userPrivacySettings: settings } = schema;

export class PrivacySettingsRepository implements PrivacySettingsStore {
  constructor(private readonly db: DoxaDb) {}

  static fromEnv(env: DbEnv): PrivacySettingsRepository {
    return new PrivacySettingsRepository(createDb(env));
  }

  async productAnalyticsEnabled(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ productAnalytics: settings.productAnalytics })
      .from(settings)
      .where(eq(settings.userId, userId))
      .limit(1);
    return row?.productAnalytics ?? true;
  }

  async setProductAnalytics(userId: string, enabled: boolean, now: Date): Promise<void> {
    await this.db
      .insert(settings)
      .values({ userId, productAnalytics: enabled, updatedAt: now })
      .onConflictDoUpdate({ target: settings.userId, set: { productAnalytics: enabled, updatedAt: now } });
  }
}

import type { PrivacySettingsStore } from "../../src/services/privacy/privacy-settings-store";

/** `user_privacy_settings` in memory, with the same default as the SQL repository. */
export class InMemoryPrivacySettings implements PrivacySettingsStore {
  readonly rows = new Map<string, { productAnalytics: boolean; updatedAt: Date }>();
  reads = 0;

  async productAnalyticsEnabled(userId: string): Promise<boolean> {
    this.reads += 1;
    return this.rows.get(userId)?.productAnalytics ?? true;
  }

  async setProductAnalytics(userId: string, enabled: boolean, now: Date): Promise<void> {
    this.rows.set(userId, { productAnalytics: enabled, updatedAt: now });
  }
}

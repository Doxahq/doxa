/** The `user_privacy_settings` table. A missing row means analytics is on. */
export interface PrivacySettingsStore {
  productAnalyticsEnabled(userId: string): Promise<boolean>;
  setProductAnalytics(userId: string, enabled: boolean, now: Date): Promise<void>;
}

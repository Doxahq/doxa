import type { PrivacySettings, UpdatePrivacySettingsInput } from "@doxahq/contracts/privacy-settings";
import type { Env } from "../../env";
import { PrivacySettingsRepository } from "../../repositories/privacy-settings";
import type { PrivacySettingsStore } from "./privacy-settings-store";

export interface PrivacySettingsServiceDeps {
  readonly store: PrivacySettingsStore;
  readonly now: () => Date;
  /** Called after a change is stored, so this process stops or starts analytics at once. */
  readonly onChange?: (userId: string, settings: PrivacySettings) => void;
}

/** The privacy switches of the signed-in user. */
export class PrivacySettingsService {
  constructor(private readonly deps: PrivacySettingsServiceDeps) {}

  static fromEnv(env: Env): PrivacySettingsService {
    return new PrivacySettingsService({
      store: PrivacySettingsRepository.fromEnv(env),
      now: () => new Date(),
      onChange: (userId, settings) => env.PRODUCT_ANALYTICS?.optOutChanged?.(userId, !settings.productAnalytics),
    });
  }

  async get(userId: string): Promise<PrivacySettings> {
    return { productAnalytics: await this.deps.store.productAnalyticsEnabled(userId) };
  }

  async update(userId: string, input: UpdatePrivacySettingsInput): Promise<PrivacySettings> {
    await this.deps.store.setProductAnalytics(userId, input.productAnalytics, this.deps.now());
    const settings: PrivacySettings = { productAnalytics: input.productAnalytics };
    this.deps.onChange?.(userId, settings);
    return settings;
  }
}

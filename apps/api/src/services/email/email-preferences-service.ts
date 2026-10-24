import {
  EMAIL_NOTIFICATION_CATEGORIES,
  type EmailNotificationCategory,
  type EmailPreferences,
} from "@doxahq/contracts/email-preferences";
import { readUnsubscribeQuery, type UnsubscribeTokens } from "@doxahq/email";
import type { Env } from "../../env";
import { EmailPreferencesRepository } from "../../repositories/email-deliveries";
import type { EmailPreferencesStore } from "./email-delivery-store";
import { unsubscribeTokensFromEnv } from "./email-outbox";

export interface EmailPreferencesServiceDeps {
  readonly store: EmailPreferencesStore;
  readonly unsubscribe: UnsubscribeTokens;
  readonly now: () => Date;
}

/** A link whose token does not match its user and category. */
export class InvalidUnsubscribeLinkError extends Error {
  constructor() {
    super("This unsubscribe link is not valid.");
    this.name = "InvalidUnsubscribeLinkError";
  }
}

/** Notification switches of the signed-in user, and the one-click unsubscribe (RFC 8058). */
export class EmailPreferencesService {
  constructor(private readonly deps: EmailPreferencesServiceDeps) {}

  static fromEnv(env: Env): EmailPreferencesService {
    return new EmailPreferencesService({
      store: EmailPreferencesRepository.fromEnv(env),
      unsubscribe: unsubscribeTokensFromEnv(env),
      now: () => new Date(),
    });
  }

  async list(userId: string): Promise<EmailPreferences> {
    const disabled = await this.deps.store.disabledCategories(userId);
    return {
      preferences: EMAIL_NOTIFICATION_CATEGORIES.map((category) => ({ category, enabled: !disabled.has(category) })),
    };
  }

  async set(userId: string, category: EmailNotificationCategory, enabled: boolean): Promise<EmailPreferences> {
    await this.deps.store.set(userId, category, enabled, this.deps.now());
    return this.list(userId);
  }

  /** The link itself authorizes the change: it is signed for one user and one category. */
  async unsubscribe(params: URLSearchParams): Promise<EmailNotificationCategory> {
    const query = readUnsubscribeQuery(params);
    if (!query || !(await this.deps.unsubscribe.verify(query.target, query.token))) {
      throw new InvalidUnsubscribeLinkError();
    }
    await this.deps.store.set(query.target.userId, query.target.category, false, this.deps.now());
    return query.target.category;
  }
}

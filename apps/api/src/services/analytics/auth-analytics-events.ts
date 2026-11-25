import type { ProductAnalytics } from "@doxahq/analytics";
import type { AuthEvents } from "@doxahq/auth";

/** Sends the auth events of `@doxahq/auth` to product analytics. */
export function authAnalyticsEvents(analytics: ProductAnalytics): AuthEvents {
  return {
    userCreated({ userId, email, method, createdAt }) {
      analytics.capture({ name: "user_signed_up", distinctId: userId, properties: { method } });
      analytics.identify({
        distinctId: userId,
        properties: { email },
        firstProperties: { signup_method: method, created_at: createdAt.toISOString() },
      });
    },
    sessionCreated({ userId, email, method }) {
      analytics.capture({ name: "user_signed_in", distinctId: userId, properties: { method } });
      // Keeps the person's email current after an email change.
      analytics.identify({ distinctId: userId, properties: { email } });
    },
    emailVerified({ userId }) {
      analytics.capture({ name: "email_verified", distinctId: userId, properties: {} });
    },
  };
}

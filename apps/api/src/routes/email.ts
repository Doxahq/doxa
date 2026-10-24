import { updateEmailPreferenceInputSchema } from "@doxahq/contracts/email-preferences";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { readValidBody } from "../http/body";
import { error, json } from "../http/response";
import { dashboardLinks, emailLinksFromEnv } from "../services/email/email-links";
import {
  EmailPreferencesService,
  InvalidUnsubscribeLinkError,
} from "../services/email/email-preferences-service";

export type EmailPreferencesServiceFactory = (context: ApiContext) => EmailPreferencesService;

const defaultPreferences: EmailPreferencesServiceFactory = (context) => EmailPreferencesService.fromEnv(context.env);

/** Mounted under `/email-preferences`: the signed-in user's notification switches. */
export function createEmailPreferencesRoutes(preferences: EmailPreferencesServiceFactory = defaultPreferences): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) => withUser(context, async (userId) => json(await preferences(context).list(userId))));
  app.put("/", (context) =>
    withUser(context, async (userId) => {
      const body = await readValidBody(context.req.raw, updateEmailPreferenceInputSchema);
      if (body === null) return error("Invalid email preference.", 400);
      return json(await preferences(context).set(userId, body.category, body.enabled));
    }),
  );
  return app;
}

/**
 * Mounted under `/email`. `POST /email/unsubscribe` is the one-click target of
 * the `List-Unsubscribe` header (RFC 8058) and of the dashboard confirmation
 * page. It needs no session: the signed link names one user and one category.
 * A `GET` (a person who opens the header link) goes to the confirmation page,
 * so that a link scanner never unsubscribes anyone.
 */
export function createEmailUnsubscribeRoutes(preferences: EmailPreferencesServiceFactory = defaultPreferences): ApiApp {
  const app = createApiRouter();
  app.post("/unsubscribe", async (context) => {
    const params = new URL(context.req.url).searchParams;
    try {
      const category = await preferences(context).unsubscribe(params);
      return json({ category, unsubscribed: true });
    } catch (cause) {
      if (cause instanceof InvalidUnsubscribeLinkError) return error(cause.message, 400, { code: "invalid_unsubscribe_link" });
      throw cause;
    }
  });
  app.get("/unsubscribe", (context) => {
    const page = new URL(dashboardLinks.unsubscribePage(emailLinksFromEnv(context.env)));
    page.search = new URL(context.req.url).search;
    return context.redirect(page.href, 302);
  });
  return app;
}

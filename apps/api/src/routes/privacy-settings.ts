import { updatePrivacySettingsInputSchema } from "@doxahq/contracts/privacy-settings";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { readValidBody } from "../http/body";
import { error, json } from "../http/response";
import { PrivacySettingsService } from "../services/privacy/privacy-settings-service";

export type PrivacySettingsServiceFactory = (context: ApiContext) => PrivacySettingsService;

const defaultSettings: PrivacySettingsServiceFactory = (context) => PrivacySettingsService.fromEnv(context.env);

/** Mounted under `/privacy-settings`: the signed-in user's privacy switches. */
export function createPrivacySettingsRoutes(settings: PrivacySettingsServiceFactory = defaultSettings): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) => withUser(context, async (userId) => json(await settings(context).get(userId))));
  app.put("/", (context) =>
    withUser(context, async (userId) => {
      const body = await readValidBody(context.req.raw, updatePrivacySettingsInputSchema);
      if (body === null) return error("Invalid privacy settings.", 400);
      return json(await settings(context).update(userId, body));
    }),
  );
  return app;
}

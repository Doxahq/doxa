import { setPageLockInputSchema } from "@doxahq/contracts/generation-reviews";
import { createApiRouter, type ApiApp } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { json, notFound } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import { PageLocksRepository } from "../repositories/page-locks";

/**
 * The pages that a person locked against generations, under
 * `/projects/:projectId/page-locks`. Every page is unlocked by default.
 */
export function createPageLockRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withProjectAccess(context, "docs.read", async (access) => {
      const pages = await new PageLocksRepository(context.env).list(access);
      return pages ? json({ pages }) : notFound();
    }),
  );

  app.put("/", (context) =>
    withProjectAccess(context, "docs.write", async (access) => {
      const input = await parseValidatedJson(context, setPageLockInputSchema, "Invalid page lock request.");
      if (!input.ok) return input.response;

      const repository = new PageLocksRepository(context.env);
      const updated = await repository.set({ ...access, ...input.data });
      if (!updated) return notFound();
      return json({ pages: (await repository.list(access)) ?? [] });
    }),
  );

  return app;
}

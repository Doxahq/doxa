import { createDocsDomainInputSchema } from "@doxahq/contracts";
import { createApiRouter } from "../http/app";
import type { ApiApp, ApiContext } from "../http/app";
import {
  withProjectAccess,
  type DashboardProjectAccess,
} from "../http/project-access";
import { parseValidatedJson } from "../http/validation";
import { error, json, notFound } from "../http/response";
import { PlanLimitError } from "@doxahq/billing";
import { planLimitResponse } from "../http/billing-errors";
import { billingConfigFor } from "../services/billing/config";
import { CreateCustomDocsDomainError } from "../repositories/docs-domains";
import { DocsDomainDnsHostService } from "../services/docs-domain-dns-host";
import {
  DocsDomainLifecycleService,
  DocsDomainProvisioningError,
  getDocsDomainProvisioningStatus,
} from "../services/docs-domain-lifecycle";

export function createDocsDomainRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withProjectAccess(context, "domains.read", (access) =>
      listDocsDomains(context, access),
    ),
  );

  app.post("/", (context) =>
    withProjectAccess(context, "domains.write", async ({ ownerUserId: userId }) => {
      const input = await parseValidatedJson(
        context,
        createDocsDomainInputSchema,
        "Invalid docs domain payload.",
      );
      if (!input.ok) return input.response;

      try {
        const projectId = context.req.param("projectId");
        if (!projectId) return notFound();

        const domain = await new DocsDomainLifecycleService(context.env).createCustomDomain({
          userId,
          projectId,
          hostname: input.data.hostname,
          docsBaseDomain: context.env.DOCS_BASE_DOMAIN,
        });
        return json({ domain }, { status: 201 });
      } catch (err) {
        if (err instanceof PlanLimitError) {
          return planLimitResponse(err, { returnBaseUrl: billingConfigFor(context.env).returnBaseUrl });
        }
        if (err instanceof CreateCustomDocsDomainError) {
          return error(err.message, getCreateDocsDomainStatus(err));
        }
        if (err instanceof DocsDomainProvisioningError) {
          return error(err.message, getDocsDomainProvisioningStatus(err));
        }
        throw err;
      }
    }),
  );

  app.get("/:domainId/dns-host", (context) =>
    withProjectAccess(context, "domains.read", async ({ ownerUserId: userId }) => {
      const projectId = context.req.param("projectId");
      if (!projectId) return notFound();

      const dnsHost = await new DocsDomainDnsHostService(context.env).detectForProject({
        userId,
        projectId,
        domainId: context.req.param("domainId"),
      });
      if (!dnsHost) return notFound();
      return json({ dnsHost });
    }),
  );

  app.post("/:domainId/refresh", (context) =>
    withProjectAccess(context, "domains.write", async ({ ownerUserId: userId }) => {
      try {
        const projectId = context.req.param("projectId");
        if (!projectId) return notFound();

        const domain = await new DocsDomainLifecycleService(context.env).refreshForProject({
          userId,
          projectId,
          domainId: context.req.param("domainId"),
        });
        if (!domain) return notFound();
        return json({ domain });
      } catch (err) {
        if (err instanceof DocsDomainProvisioningError) {
          return error(err.message, getDocsDomainProvisioningStatus(err));
        }
        throw err;
      }
    }),
  );

  app.delete("/:domainId", (context) =>
    withProjectAccess(context, "domains.write", async ({ ownerUserId: userId }) => {
      try {
        const projectId = context.req.param("projectId");
        if (!projectId) return notFound();

        const deleted = await new DocsDomainLifecycleService(context.env).deleteForProject({
          userId,
          projectId,
          domainId: context.req.param("domainId"),
        });
        if (!deleted) return notFound();
        return json({ ok: true });
      } catch (err) {
        if (err instanceof DocsDomainProvisioningError) {
          return error(err.message, getDocsDomainProvisioningStatus(err));
        }
        throw err;
      }
    }),
  );

  return app;
}

function getCreateDocsDomainStatus(error: CreateCustomDocsDomainError): number {
  switch (error.code) {
    case "invalid_hostname":
    case "reserved_hostname":
      return 400;
    case "project_not_found":
      return 404;
    case "hostname_taken":
      return 409;
  }
}

/** `GET /projects/:projectId/docs-domains`, after `domains.read` passed. */
export async function listDocsDomains(
  context: ApiContext,
  { ownerUserId: userId }: DashboardProjectAccess,
): Promise<Response> {
  const projectId = context.req.param("projectId");
  if (!projectId) return notFound();

  const collection = await new DocsDomainLifecycleService(context.env).listForProject({
    userId,
    projectId,
  });
  if (!collection) return notFound();
  return json(collection);
}

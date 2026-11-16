import type { DocsExportStatus } from "@doxahq/contracts/docs-export";
import type { Capability } from "@doxahq/contracts/teams";
import type { Env } from "../env";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { error, json } from "../http/response";
import { createStreamSlots } from "../services/agent-live/agent-activity-stream";
import {
  ExportBillingUnavailableError,
  exportBillingFromEnv,
  type ExportBilling,
  type ExportQuotaView,
} from "../services/billing/export-billing";
import { EXPORT_MAX_BYTES } from "../services/docs-export/entries";
import { DocsExportService, type DocsExportPlan } from "../services/docs-export/service";

/** How the routes get their services; tests pass fakes. */
export interface DocsExportRouteServices {
  exports(env: Env): Pick<DocsExportService, "prepare">;
  billing(env: Env): ExportBilling;
}

const servicesFromEnv: DocsExportRouteServices = {
  exports: (env) => DocsExportService.fromEnv(env),
  billing: (env) => exportBillingFromEnv(env),
};

/** Open exports of one project on this process. */
const MAX_OPEN_EXPORTS_PER_PROJECT = 1;
/** Open exports of every project on this process: one API task serves the whole dashboard. */
const MAX_OPEN_EXPORTS_PER_PROCESS = 3;
const PROCESS_SLOT_KEY = "*";
const RETRY_IN_PROGRESS_SECONDS = 30;
/**
 * A client that stays connected but never reads would hold its slots. The
 * export stops after this time; a full 1 GB archive needs far less.
 */
export const EXPORT_MAX_DURATION_MS = 30 * 60 * 1000;
/** The export stops when the client reads nothing for this long. */
export const EXPORT_IDLE_TIMEOUT_MS = 60 * 1000;
/**
 * A server failure gives the export back only before this share of the
 * archive is sent, so a failure late in a download is never a free export.
 */
const REFUND_BEFORE_SHARE = 0.1;

/**
 * Editors and up: an export spends the quota of the project's billing
 * account, so a viewer must not use the export of the owner.
 */
const EXPORT_CAPABILITY = "docs.write" satisfies Capability;

const NO_STORE = { "cache-control": "no-store" } as const;

/** Mounted under `/projects/:projectId/export`. */
export function createDocsExportRoutes(services = servicesFromEnv): ApiApp {
  const app = createApiRouter();
  const projectSlots = createStreamSlots(MAX_OPEN_EXPORTS_PER_PROJECT);
  const processSlots = createStreamSlots(MAX_OPEN_EXPORTS_PER_PROCESS);

  app.get("/status", (context) =>
    withProjectAccess(context, EXPORT_CAPABILITY, async (access) => {
      const plan = await services.exports(context.env).prepare(access);
      let quota: ExportQuotaView;
      try {
        quota = await services.billing(context.env).status(access.projectId);
      } catch (cause) {
        if (cause instanceof ExportBillingUnavailableError) return unavailable();
        throw cause;
      }
      return json(statusBody(plan, quota), { headers: NO_STORE });
    }),
  );

  app.get("/", (context) =>
    withProjectAccess(context, EXPORT_CAPABILITY, async (access) => {
      // Hono answers HEAD with the GET handler and drops the body without a
      // cancel. That would spend the quota and hold the slots, so refuse it.
      if (context.req.method === "HEAD") return methodNotAllowed();
      // A GET passes the CSRF check, and a top-level navigation carries the
      // session cookie. Refuse a request that another site started, so no
      // other site can spend the export quota of a user.
      if (isCrossSite(context)) return error("Cross-site request blocked.", 403, { code: "cross_site" });
      // The dashboard opens this route as a link. An error page would replace
      // the dashboard with raw JSON, so a navigation goes back to the
      // settings page with the error code instead.
      const refuse = (response: Response, code: string) => backToSettings(context, access.projectId, code) ?? response;

      const plan = await services.exports(context.env).prepare(access);
      if (plan.kind === "no_published_version") {
        return refuse(error("Publish the docs before you export them.", 404, { code: "no_published_version" }), "no_published_version");
      }
      if (plan.kind === "too_large") {
        return refuse(
          error("The docs are too large to export as one archive.", 413, {
            code: "export_too_large",
            sizeBytes: plan.sizeBytes,
            maxBytes: EXPORT_MAX_BYTES,
          }),
          "export_too_large",
        );
      }

      const releaseProject = projectSlots.acquire(access.projectId);
      if (releaseProject === null) return refuse(inProgress("An export of this project is already running."), "export_in_progress");
      const releaseProcess = processSlots.acquire(PROCESS_SLOT_KEY);
      if (releaseProcess === null) {
        releaseProject();
        return refuse(inProgress("Too many exports are running. Try again in a moment."), "export_in_progress");
      }
      const releaseSlots = () => {
        releaseProcess();
        releaseProject();
      };

      let reservation;
      try {
        reservation = await services.billing(context.env).reserve(access.projectId);
      } catch (cause) {
        releaseSlots();
        if (cause instanceof ExportBillingUnavailableError) return refuse(unavailable(), "export_unavailable");
        throw cause;
      }
      if (!reservation.allowed) {
        releaseSlots();
        return refuse(quotaSpent(reservation.quota), "export_limit");
      }

      const quotaRelease = reservation.release;
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = plan.open({
          signal: AbortSignal.timeout(EXPORT_MAX_DURATION_MS),
          idleTimeoutMs: EXPORT_IDLE_TIMEOUT_MS,
          onComplete: releaseSlots,
          // Our failure (storage, integrity): give the export back, but only
          // early in the download.
          onError: (cause, { bytesSent }) => {
            releaseSlots();
            logExportFailure(access.projectId, cause);
            if (bytesSent >= plan.sizeBytes * REFUND_BEFORE_SHARE) return;
            void quotaRelease().catch((releaseError) => logExportFailure(access.projectId, releaseError));
          },
          // The client left: the export counts, so a loop of canceled
          // downloads cannot read the site without limit.
          onCancel: releaseSlots,
        });
      } catch (cause) {
        releaseSlots();
        await quotaRelease();
        throw cause;
      }

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${plan.fileName}"`,
          "cache-control": "no-store, private",
          "x-content-type-options": "nosniff",
        },
      });
    }),
  );

  return app;
}

function statusBody(plan: DocsExportPlan, quota: ExportQuotaView): DocsExportStatus {
  const published = plan.kind === "no_published_version" ? null : plan;
  const reason =
    plan.kind === "no_published_version"
      ? "no_published_version"
      : plan.kind === "too_large"
        ? "too_large"
        : quota.available
          ? null
          : "quota_spent";
  return {
    available: reason === null,
    reason,
    version: published ? published.version : null,
    sizeBytes: published ? published.sizeBytes : null,
    maxBytes: EXPORT_MAX_BYTES,
    quota,
  };
}

/** A 303 to the project settings of the dashboard, for a browser navigation only. */
function backToSettings(context: ApiContext, projectId: string, code: string): Response | null {
  if (context.req.header("sec-fetch-mode") !== "navigate") return null;
  const origin = dashboardOrigin(context.env.WEB_ORIGIN);
  if (!origin) return null;
  const target = new URL(`/dashboard/projects/${encodeURIComponent(projectId)}/settings`, origin);
  target.searchParams.set("export_error", code);
  return new Response(null, { status: 303, headers: { location: target.toString(), "cache-control": "no-store" } });
}

/** Only the configured dashboard origin, never a value from the request. */
function dashboardOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function methodNotAllowed(): Response {
  const response = error("Use GET to download the export.", 405, { code: "method_not_allowed" });
  response.headers.set("allow", "GET");
  return response;
}

function isCrossSite(context: ApiContext): boolean {
  return context.req.header("sec-fetch-site") === "cross-site";
}

function inProgress(message: string): Response {
  return withHeaders(error(message, 429, { code: "export_in_progress" }), { "retry-after": String(RETRY_IN_PROGRESS_SECONDS) });
}

function quotaSpent(quota: ExportQuotaView): Response {
  const resetsAt = quota.resetsAt ? new Date(quota.resetsAt) : null;
  const retryAfter = resetsAt ? Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000)) : 3600;
  const message =
    quota.windowHours === 24
      ? "Your plan allows one export a day. Try again tomorrow."
      : "Your plan allows one export an hour. Try again later.";
  return withHeaders(error(message, 429, { code: "export_limit", ...quota }), { "retry-after": String(retryAfter) });
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  response.headers.set("cache-control", "no-store");
  return response;
}

function unavailable(): Response {
  return error("Export is not available right now. Try again in a few minutes.", 503, { code: "export_unavailable" });
}

function logExportFailure(projectId: string, cause: unknown): void {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
  console.error(JSON.stringify({ service: "doxa-api", event: "docs_export.failed", projectId, message }));
}

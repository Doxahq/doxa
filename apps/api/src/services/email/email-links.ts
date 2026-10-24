import type { Env } from "../../env";

const LOCAL_WEB_ORIGIN = "http://localhost:3001";
const LOCAL_API_ORIGIN = "http://localhost:8787";

/** Public origins for links inside emails. Emails are built outside a request, so no request origin exists. */
export interface EmailLinks {
  readonly webOrigin: string;
  readonly apiOrigin: string;
}

export function emailLinksFromEnv(env: Pick<Env, "WEB_ORIGIN" | "BETTER_AUTH_URL">): EmailLinks {
  return {
    webOrigin: trimOrigin(env.WEB_ORIGIN) ?? LOCAL_WEB_ORIGIN,
    // BETTER_AUTH_URL is the API's own public origin, for example https://api.doxa.so.
    apiOrigin: trimOrigin(env.BETTER_AUTH_URL) ?? LOCAL_API_ORIGIN,
  };
}

/** Dashboard pages that emails link to. Paths match the routes in apps/web. */
export const dashboardLinks = {
  approvalRequest: (links: EmailLinks, requestId: string) => `${links.webOrigin}/approve/${encodeURIComponent(requestId)}`,
  generation: (links: EmailLinks, projectId: string, jobId: string) =>
    `${links.webOrigin}/dashboard/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(jobId)}`,
  domains: (links: EmailLinks, projectId: string) =>
    `${links.webOrigin}/dashboard/projects/${encodeURIComponent(projectId)}/site/domains`,
  teamInvite: (links: EmailLinks, token: string) => `${links.webOrigin}/invite/${token}`,
  /** The page that confirms an unsubscribe link from an email footer. */
  unsubscribePage: (links: EmailLinks) => `${links.webOrigin}/email/unsubscribe`,
  /** The one-click endpoint in the `List-Unsubscribe` header (RFC 8058). */
  unsubscribeEndpoint: (links: EmailLinks) => `${links.apiOrigin}/email/unsubscribe`,
} as const;

function trimOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

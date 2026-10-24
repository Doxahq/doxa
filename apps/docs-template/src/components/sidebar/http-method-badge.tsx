import type { IconName } from "@/src/settings/icons";
import { normalizeApiMethod } from "@/src/lib/api-reference";
import { DocsIcon } from "@/src/components/docs-icon";
import { ApiMethodBadge } from "@/src/components/markdown/api-method-badge";

export function isHttpMethodBadge(value: string | undefined): boolean {
  return normalizeApiMethod(value) !== undefined;
}

export function HttpMethodBadge({ method }: { method: string }) {
  return <ApiMethodBadge method={method} compact />;
}

export function SidebarNavMarker({
  icon,
  badge,
}: {
  icon?: IconName;
  badge?: string;
}) {
  const method = normalizeApiMethod(badge);
  if (method) {
    return <HttpMethodBadge method={method} />;
  }

  return <DocsIcon name={icon} className="h-4 w-4 shrink-0" />;
}

/**
 * Legacy artifacts titled endpoint pages with the method and path (`GET /health`).
 * The badge already shows the method, so that prefix was noise. Generated titles
 * are now plain English, and their leading verb can match the method name
 * ("Delete a flag" under a DELETE badge). Strip the prefix only when a URL path
 * follows it, so a real title keeps its verb.
 */
export function sidebarNavTitle(
  title: string,
  badge: string | undefined
): string {
  const method = normalizeApiMethod(badge);
  if (!method) return title;
  return title.replace(new RegExp(`^${method}\\s+(?=/)`, "i"), "");
}

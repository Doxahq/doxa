import { getTrustedOrigins } from "@doxahq/auth";
import type { Env } from "../env";
import { error } from "./response";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_EXEMPT_PREFIXES = ["/api/auth", "/internal"];
/**
 * `/email/unsubscribe` is posted by mail clients (RFC 8058), which send no
 * Origin header. Its signed link is the authorization, and it only turns off
 * one notification category.
 */
const CSRF_EXEMPT_PATHS = new Set(["/github/webhook", "/email/unsubscribe"]);

export function enforceMutationCsrf(request: Request, env: Env, pathname: string): Response | null {
  if (SAFE_METHODS.has(request.method)) return null;
  if (isCsrfExemptPath(pathname)) return null;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return error("Cross-site request blocked.", 403);
  }

  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) {
    return error("Invalid request origin.", 403);
  }

  if (!isTrustedOrigin(origin, getTrustedOrigins(env))) {
    return error("Invalid request origin.", 403);
  }

  return null;
}

function isCsrfExemptPath(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.has(pathname) || CSRF_EXEMPT_PREFIXES.some((prefix) => isPathAtOrBelow(pathname, prefix));
}

function isPathAtOrBelow(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isTrustedOrigin(origin: string, trustedOrigins: string[]): boolean {
  return trustedOrigins.some((candidate) => matchesTrustedOrigin(origin, candidate));
}

function matchesTrustedOrigin(origin: string, candidate: string): boolean {
  const trustedOrigin = normalizeTrustedOriginPattern(candidate);
  if (!trustedOrigin) return false;
  if (!trustedOrigin.includes("*")) return origin === trustedOrigin;

  const pattern = trustedOrigin
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${pattern}$`).test(origin);
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value || value === "null") return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeTrustedOriginPattern(value: string | null | undefined): string | null {
  if (!value || value === "null") return null;

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed.includes("*")) return normalizeOrigin(trimmed);

  try {
    return new URL(trimmed.replaceAll("*", "wildcard")).origin.replaceAll("wildcard", "*");
  } catch {
    return null;
  }
}

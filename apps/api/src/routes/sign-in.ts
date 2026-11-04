import { createAuth, getTrustedOrigins } from "@doxahq/auth";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { isTrustedOrigin } from "../http/csrf";
import { error } from "../http/response";

export type AuthRequestHandler = (context: ApiContext, request: Request) => Promise<Response>;

const SIGN_IN_PROVIDERS = new Set(["github", "google"]);
const DEFAULT_REDIRECT_PATH = "/dashboard";
const MAX_REDIRECT_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
export const SIGN_IN_UNAVAILABLE_ERROR = "sign-in-unavailable";

const defaultAuthHandler: AuthRequestHandler = (context, request) =>
  createAuth(context.env, request, context.executionCtx).handler(request);

/**
 * Mounted under `/sign-in`. `GET /sign-in/:provider?redirect=/path` starts a
 * social sign-in from a plain link, so the login page works before its
 * JavaScript loads. Better Auth only starts a sign-in from a `POST` that
 * returns JSON. This route sends that `POST` through the Better Auth handler,
 * so its callback URL check and rate limit still apply, then answers with a
 * redirect to the provider.
 */
export function createSignInRoutes(authHandler: AuthRequestHandler = defaultAuthHandler): ApiApp {
  const app = createApiRouter();
  app.get("/:provider", async (context) => {
    const provider = context.req.param("provider");
    if (!SIGN_IN_PROVIDERS.has(provider)) return error("Unknown sign-in provider.", 404);

    const request = context.req.raw;
    // Another site must not start a sign-in in a visitor's browser.
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return error("Cross-site request blocked.", 403);
    }

    const webOrigin = resolveWebOrigin(context);
    if (!webOrigin) return error("Sign-in is not configured.", 500);

    const redirectPath = safeRedirectPath(context.req.query("redirect"));
    const callbackURL = new URL(redirectPath, webOrigin).href;
    // A provider error (for example an email that belongs to an unverified
    // password account) returns to the login page, which shows it.
    const errorPage = new URL("/login", webOrigin);
    errorPage.searchParams.set("redirect", redirectPath);
    const errorCallbackURL = errorPage.href;

    const response = await authHandler(
      context,
      socialSignInRequest(request, webOrigin, { provider, callbackURL, errorCallbackURL }),
    )
      .catch(() => null);
    const providerUrl = response?.ok ? await readProviderUrl(response) : null;

    if (!response || !providerUrl) {
      const loginPage = new URL("/login", webOrigin);
      loginPage.searchParams.set("error", SIGN_IN_UNAVAILABLE_ERROR);
      loginPage.searchParams.set("redirect", redirectPath);
      return redirectTo(loginPage.href);
    }

    const redirect = redirectTo(providerUrl);
    // The state cookie ties the provider callback to this browser.
    for (const cookie of response.headers.getSetCookie()) {
      redirect.headers.append("set-cookie", cookie);
    }
    return redirect;
  });
  return app;
}

/**
 * The web app that sent the person here, from the `Referer` of the link, when
 * it is a trusted origin. Otherwise the configured web origin.
 */
function resolveWebOrigin(context: ApiContext): string | null {
  const referer = parseOrigin(context.req.header("referer"));
  if (referer && isTrustedOrigin(referer, getTrustedOrigins(context.env))) return referer;
  return parseOrigin(context.env.WEB_ORIGIN);
}

/**
 * A path on the web app, or `/dashboard`. The full callback URL is checked
 * again by Better Auth against the trusted origins.
 */
function safeRedirectPath(value: string | undefined): string {
  if (!value || value.length > MAX_REDIRECT_LENGTH) return DEFAULT_REDIRECT_PATH;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_REDIRECT_PATH;
  if (CONTROL_CHARACTERS.test(value)) return DEFAULT_REDIRECT_PATH;
  return value;
}

/**
 * The `POST` that the Better Auth client sends. The `Origin` is the web app,
 * like a click on the login page after it loads.
 */
function socialSignInRequest(
  request: Request,
  webOrigin: string,
  body: { provider: string; callbackURL: string; errorCallbackURL: string },
): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", webOrigin);
  headers.delete("content-length");

  return new Request(new URL("/api/auth/sign-in/social", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readProviderUrl(response: Response): Promise<string | null> {
  const payload: unknown = await response.json().catch(() => null);
  if (typeof payload !== "object" || payload === null || !("url" in payload)) return null;
  return typeof payload.url === "string" ? payload.url : null;
}

function redirectTo(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

function parseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

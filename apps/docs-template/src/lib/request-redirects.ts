type RedirectStatus = 301 | 302 | 303 | 307 | 308;

interface RedirectDecision {
  redirectPath: string;
  status: RedirectStatus;
}

export function getRedirectDecision(pathname: string): RedirectDecision | null {
  const status: RedirectStatus = 308;

  if (pathname === "/") {
    return null;
  }

  if (pathname.startsWith("/docs/assets/")) {
    return {
      redirectPath: pathname.replace(/^\/docs\/assets/, "/assets"),
      status,
    };
  }

  if (pathname === "/docs") {
    return { redirectPath: "/", status: 307 };
  }

  if (pathname.startsWith("/docs/")) {
    return { redirectPath: pathname.slice("/docs".length) || "/", status };
  }

  return null;
}

export function getRedirectPath(pathname: string): string | null {
  return getRedirectDecision(pathname)?.redirectPath ?? null;
}

export function getRedirectResponse(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  const decision = getRedirectDecision(pathname);

  if (!decision) return null;

  return redirectToPath(request.url, decision.redirectPath, decision.status);
}

export function redirectToPath(
  url: string,
  pathname: string,
  status: RedirectStatus = 308
) {
  const redirectUrl = new URL(url);
  redirectUrl.pathname = pathname;

  return Response.redirect(redirectUrl.toString(), status);
}

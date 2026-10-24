import { getSessionUser, type AuthenticatedUser } from "@doxahq/auth";
import type { ApiContext } from "./app";
import { getLocalDevUserId } from "./access";
import { requestState } from "./request-state";
import { error, json } from "./response";
import { ensureLocalDevUser } from "../services/local-dev-user";

export async function withUser(
  context: ApiContext,
  handler: (userId: string) => Promise<Response>,
): Promise<Response> {
  const localDevUserId = getLocalDevUserId(context.req.raw, context.env);
  if (localDevUserId) {
    await ensureLocalDevUser(context.env, localDevUserId);
    requestState(context.req.raw, context.env).timing.setViewer({
      isAdmin: context.env.DEV_ADMIN_ENABLED === "true",
    });
    return handler(localDevUserId);
  }

  const sessionUser = await requestSessionUser(context);
  const userId = sessionUser?.id;

  if (!userId) {
    return error("Authentication required.", 401);
  }

  return handler(userId);
}

/** `GET /me`: the signed-in person, or 401. The dashboard uses it as its session probe. */
export async function handleCurrentUser(context: ApiContext): Promise<Response> {
  const localDevUserId = getLocalDevUserId(context.req.raw, context.env);
  if (localDevUserId) {
    return json({ user: { id: localDevUserId, email: "local-dev@doxa.local" } });
  }

  const sessionUser = await requestSessionUser(context);
  if (!sessionUser?.id) {
    return error("Authentication required.", 401);
  }

  return json({ user: { id: sessionUser.id, email: sessionUser.email ?? null } });
}

/**
 * The session user of this request. The first call reads the session; later
 * calls in the same request reuse that answer, so a request checks its
 * session once. A failed lookup is not kept.
 *
 * The lookup also decides the Server-Timing header (only for admins) and
 * collects the session cookie cache value that the response sets.
 */
export function requestSessionUser(
  context: ApiContext,
): Promise<AuthenticatedUser | null> {
  const state = requestState(context.req.raw, context.env);
  if (state.sessionUser) return state.sessionUser;

  const pending = state.timing
    .measure("auth", () =>
      getSessionUser(context.env, context.req.raw, {
        onSessionCookies: (setCookies) => state.setCookies.push(...setCookies),
      }),
    )
    .then((user) => {
      state.timing.setViewer({
        isAdmin: isAdminEmail(user?.email, context.env?.ADMIN_EMAILS),
      });
      return user;
    });
  state.sessionUser = pending;
  pending.catch(() => {
    if (state.sessionUser === pending) state.sessionUser = undefined;
  });
  return pending;
}

function isAdminEmail(email: string | undefined, adminEmails: string | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return adminEmails
    ?.split(",")
    .map((candidate) => candidate.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized) ?? false;
}

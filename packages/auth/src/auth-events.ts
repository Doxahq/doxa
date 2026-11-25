/** How a person signed up or signed in. */
export type AuthSignInMethod = "github" | "google" | "email";

export interface AuthUserCreatedEvent {
  readonly userId: string;
  readonly email: string;
  readonly method: AuthSignInMethod;
  readonly createdAt: Date;
}

export interface AuthSessionCreatedEvent {
  readonly userId: string;
  readonly email: string;
  readonly method: AuthSignInMethod;
}

export interface AuthEmailVerifiedEvent {
  readonly userId: string;
}

/**
 * What happened in sign-up and sign-in, for a reporter such as product
 * analytics. Each call must return at once. A call that throws is ignored:
 * a reporter never fails or changes auth.
 */
export interface AuthEvents {
  userCreated(event: AuthUserCreatedEvent): void;
  sessionCreated(event: AuthSessionCreatedEvent): void;
  emailVerified(event: AuthEmailVerifiedEvent): void;
}

/** The part of the Better Auth endpoint context that a database hook gets and these hooks read. */
export interface AuthHookContext {
  readonly path?: string;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly context: {
    runInBackground(task: Promise<unknown>): void;
    readonly internalAdapter: {
      findUserById(userId: string): Promise<{ readonly email: string } | null>;
    };
  };
}

const SOCIAL_METHODS = ["github", "google"] as const satisfies readonly AuthSignInMethod[];

/**
 * The sign-in method of the endpoint that created the user or the session,
 * or null when the endpoint does not say (a password change, a server call
 * without a context). A null method sends no event: it is never guessed.
 */
export function signInMethodOf(context: AuthHookContext | null): AuthSignInMethod | null {
  const path = context?.path;
  if (!path) return null;
  if (path === "/sign-up/email" || path === "/sign-in/email" || path === "/verify-email") return "email";
  // The OAuth redirect back from GitHub or Google: `/callback/:id`.
  if (path.startsWith("/callback/")) return socialMethod(context.params?.id ?? path.slice("/callback/".length));
  // An ID token sign-in names its provider in the body.
  if (path === "/sign-in/social") return socialMethod(providerOf(context.body));
  return null;
}

/** The Better Auth hooks that report to `events`. None of them can fail or slow auth. */
export function authEventHooks(events: AuthEvents) {
  return {
    async userCreated(
      user: { readonly id: string; readonly email: string; readonly createdAt: Date },
      context: AuthHookContext | null,
    ): Promise<void> {
      report(() => {
        const method = signInMethodOf(context);
        if (method) events.userCreated({ userId: user.id, email: user.email, method, createdAt: user.createdAt });
      });
    },
    async sessionCreated(session: { readonly userId: string }, context: AuthHookContext | null): Promise<void> {
      report(() => {
        const method = signInMethodOf(context);
        if (!method || !context) return;
        // The session has no email. Reading it waits for the database, so it
        // runs after the response.
        context.context.runInBackground(
          context.context.internalAdapter.findUserById(session.userId).then(
            (user) => {
              if (user) report(() => events.sessionCreated({ userId: session.userId, email: user.email, method }));
            },
            () => undefined,
          ),
        );
      });
    },
    async emailVerified(user: { readonly id: string }): Promise<void> {
      report(() => events.emailVerified({ userId: user.id }));
    },
  };
}

function socialMethod(provider: unknown): AuthSignInMethod | null {
  return SOCIAL_METHODS.find((method) => method === provider) ?? null;
}

function providerOf(body: unknown): unknown {
  return typeof body === "object" && body !== null && "provider" in body ? body.provider : undefined;
}

function report(send: () => void): void {
  try {
    send();
  } catch {
    // A reporter must not break auth.
  }
}

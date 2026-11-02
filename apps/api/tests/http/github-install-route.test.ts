import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * SECURITY REGRESSION GUARDRAIL (SEC-001, C1 in the 2026-10-30 audit).
 * Any signed-in user could open /github/install/callback with the
 * installation_id of another customer and take over that installation. The
 * callback must not record anything. Only /install/authorize records an
 * installation, and only after GitHub confirms that the user's own GitHub
 * account can access it.
 */
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const mocks = vi.hoisted(() => ({
  userId: "user-1",
  recordInstallation: vi.fn(),
  recordRepository: vi.fn(),
  removeRepositoriesExcept: vi.fn(),
  exchangeUserAuthorizationCode: vi.fn(),
  findUserInstallation: vi.fn(),
  listUserInstallationRepositories: vi.fn(),
}));

vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) =>
    handler(mocks.userId),
}));

vi.mock("../../src/repositories/github", () => ({
  GitHubRepository: class {
    recordInstallation = mocks.recordInstallation;
    recordRepository = mocks.recordRepository;
    removeRepositoriesExcept = mocks.removeRepositoriesExcept;
  },
}));

vi.mock("../../src/services/github-app", async (original) => ({
  ...(await original<typeof import("../../src/services/github-app")>()),
  exchangeUserAuthorizationCode: mocks.exchangeUserAuthorizationCode,
  findUserInstallation: mocks.findUserInstallation,
  listUserInstallationRepositories: mocks.listUserInstallationRepositories,
}));

import { createGitHubRoutes } from "../../src/routes/github";
import { GitHubAuthorizationError } from "../../src/services/github-app";

const app = createGitHubRoutes();

const env = {
  BETTER_AUTH_SECRET: "test-secret",
  BETTER_AUTH_URL: "https://api.doxa.so",
  WEB_ORIGIN: "https://doxa.so",
  GITHUB_CLIENT_ID: "Iv1.client",
  GITHUB_CLIENT_SECRET: "client-secret",
};

function request(path: string, init: RequestInit = {}, overrides: Record<string, unknown> = {}) {
  return Promise.resolve(
    app.request(new Request(`https://api.doxa.so${path}`, init), undefined, { ...env, ...overrides } as never),
  );
}

/** Runs the callback as the given user and returns the state and nonce cookie it hands out. */
async function startAuthorization(installationId: string, userId = "user-1") {
  mocks.userId = userId;
  const response = await request(`/install/callback?installation_id=${installationId}&setup_action=install`);
  const location = new URL(response.headers.get("location") ?? "");
  const cookie = response.headers.get("set-cookie") ?? "";
  return {
    response,
    location,
    state: location.searchParams.get("state") ?? "",
    nonce: /doxa_github_install=([^;]*)/.exec(cookie)?.[1] ?? "",
  };
}

function authorize(state: string, nonce: string | null, extra = "code=code-1") {
  return request(`/install/authorize?${extra}&state=${encodeURIComponent(state)}`, {
    headers: nonce === null ? {} : { cookie: `doxa_github_install=${nonce}` },
  });
}

describe("GitHub install routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = "user-1";
    mocks.exchangeUserAuthorizationCode.mockResolvedValue("ghu_user");
    mocks.findUserInstallation.mockResolvedValue({
      installationId: "4242",
      accountLogin: "acme",
      accountType: "Organization",
    });
    mocks.listUserInstallationRepositories.mockResolvedValue({
      repositories: [
        {
          githubRepoId: "7",
          fullName: "acme/docs",
          owner: "acme",
          name: "docs",
          defaultBranch: "main",
          isPrivate: true,
        },
      ],
      complete: true,
    });
    mocks.removeRepositoriesExcept.mockResolvedValue(0);
    mocks.recordInstallation.mockResolvedValue({ id: "installation-row-1" });
    mocks.recordRepository.mockResolvedValue({ id: "repository-row-1" });
  });

  test("the callback records nothing and sends the user to GitHub authorization", async () => {
    const { response, location, state, nonce } = await startAuthorization("4242");

    expect(response.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.client");
    expect(location.searchParams.get("redirect_uri")).toBe("https://api.doxa.so/github/install/authorize");
    expect(state).not.toBe("");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("set-cookie")).toMatch(
      /Path=\/github\/install; Max-Age=600; HttpOnly; SameSite=Lax; Secure/,
    );
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
    expect(mocks.recordRepository).not.toHaveBeenCalled();
  });

  test.each(["abc", "0", "12 34", "-1", "1".repeat(21)])(
    "the callback rejects the installation_id %j",
    async (installationId) => {
      const response = await request(`/install/callback?installation_id=${encodeURIComponent(installationId)}`);

      expect(response.status).toBe(400);
      expect(mocks.recordInstallation).not.toHaveBeenCalled();
    },
  );

  test("the callback refuses local installations without LOCAL_GITHUB_TOKEN", async () => {
    const response = await request("/install/callback?installation_id=local-dev");

    expect(response.status).toBe(400);
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });

  test("the callback records local installations in development", async () => {
    const response = await request("/install/callback?installation_id=local-dev", {}, {
      LOCAL_GITHUB_TOKEN: "ghp_local",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://doxa.so/dashboard?github=connected");
    expect(mocks.recordInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", installationId: "local-dev" }),
    );
  });

  test("an install request to an organization owner goes back to the dashboard", async () => {
    const response = await request("/install/callback?setup_action=request");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://doxa.so/dashboard?github=requested");
  });

  test("authorize links the installation that GitHub confirms for the user", async () => {
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://doxa.so/dashboard?github=connected");
    expect(response.headers.get("set-cookie")).toMatch(/doxa_github_install=; Path=\/github\/install; Max-Age=0/);
    expect(mocks.exchangeUserAuthorizationCode).toHaveBeenCalledWith(
      expect.anything(),
      "code-1",
      "https://api.doxa.so/github/install/authorize",
    );
    expect(mocks.findUserInstallation).toHaveBeenCalledWith("ghu_user", "4242");
    expect(mocks.recordInstallation).toHaveBeenCalledWith({
      userId: "user-1",
      installationId: "4242",
      accountLogin: "acme",
      accountType: "Organization",
    });
    expect(mocks.listUserInstallationRepositories).toHaveBeenCalledWith("ghu_user", "4242");
    expect(mocks.recordRepository).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "installation-row-1", githubRepoId: "7" }),
    );
  });

  test("authorize removes the repositories that the user's token no longer sees", async () => {
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(302);
    expect(mocks.removeRepositoriesExcept).toHaveBeenCalledWith("installation-row-1", ["7"]);
    // The listed repositories are recorded before anything is removed.
    expect(mocks.recordRepository.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeRepositoriesExcept.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("authorize removes every repository row when the user's token sees none", async () => {
    mocks.listUserInstallationRepositories.mockResolvedValue({ repositories: [], complete: true });
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(302);
    expect(mocks.removeRepositoriesExcept).toHaveBeenCalledWith("installation-row-1", []);
  });

  test("authorize removes nothing when the repository list stopped at the page cap", async () => {
    mocks.listUserInstallationRepositories.mockResolvedValue({
      repositories: [
        { githubRepoId: "7", fullName: "acme/docs", owner: "acme", name: "docs", defaultBranch: "main", isPrivate: true },
      ],
      complete: false,
    });
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(302);
    expect(mocks.recordRepository).toHaveBeenCalled();
    expect(mocks.removeRepositoriesExcept).not.toHaveBeenCalled();
  });

  test("authorize removes nothing when GitHub cannot list the repositories", async () => {
    mocks.listUserInstallationRepositories.mockRejectedValue(new Error("GitHub answered 500"));
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(502);
    expect(mocks.removeRepositoriesExcept).not.toHaveBeenCalled();
  });

  test("authorize refuses an installation that the user's GitHub account cannot access", async () => {
    mocks.findUserInstallation.mockResolvedValue(null);
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(403);
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
    expect(mocks.recordRepository).not.toHaveBeenCalled();
  });

  test("authorize keeps an installation that another Doxa user owns", async () => {
    mocks.recordInstallation.mockResolvedValue(null);
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(409);
    expect(mocks.recordRepository).not.toHaveBeenCalled();
    expect(mocks.removeRepositoriesExcept).not.toHaveBeenCalled();
  });

  test("authorize refuses a request without the nonce cookie of the browser that started it", async () => {
    const { state } = await startAuthorization("4242");

    const response = await authorize(state, null);

    expect(response.status).toBe(403);
    expect(mocks.exchangeUserAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });

  test("authorize refuses a nonce cookie that does not match the state", async () => {
    const { state } = await startAuthorization("4242");
    const other = await startAuthorization("4242");

    const response = await authorize(state, other.nonce);

    expect(response.status).toBe(403);
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });

  test("authorize refuses a state that another Doxa user started", async () => {
    const { state, nonce } = await startAuthorization("4242", "attacker");
    mocks.userId = "victim";

    const response = await authorize(state, nonce);

    expect(response.status).toBe(403);
    expect(mocks.exchangeUserAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });

  test("authorize refuses a state signed with another secret", async () => {
    const { state, nonce } = await startAuthorization("4242");

    const response = await request(`/install/authorize?code=code-1&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `doxa_github_install=${nonce}` },
    }, { BETTER_AUTH_SECRET: "other-secret" });

    expect(response.status).toBe(403);
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });

  test("authorize refuses when the user denied the GitHub authorization", async () => {
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce, "error=access_denied");

    expect(response.status).toBe(403);
    expect(mocks.exchangeUserAuthorizationCode).not.toHaveBeenCalled();
  });

  test("authorize answers 502 and clears the nonce when GitHub fails", async () => {
    mocks.findUserInstallation.mockRejectedValue(new Error("GitHub user installations request failed (500)."));
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(502);
    expect(response.headers.get("set-cookie")).toMatch(/doxa_github_install=; Path=\/github\/install; Max-Age=0/);
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });

  test("authorize refuses a code that GitHub rejects", async () => {
    mocks.exchangeUserAuthorizationCode.mockRejectedValue(new GitHubAuthorizationError("bad_verification_code"));
    const { state, nonce } = await startAuthorization("4242");

    const response = await authorize(state, nonce);

    expect(response.status).toBe(403);
    expect(mocks.recordInstallation).not.toHaveBeenCalled();
  });
});

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
  fetchGitHubTokenUser: vi.fn(),
  findInstallationOwner: vi.fn(),
  findInstaller: vi.fn(),
  listInstallationsForOwner: vi.fn(),
  listOwnerTransferTargets: vi.fn(),
  transferInstallationOwner: vi.fn(),
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
    findInstallationOwner = mocks.findInstallationOwner;
    listInstallationsForOwner = mocks.listInstallationsForOwner;
    listOwnerTransferTargets = mocks.listOwnerTransferTargets;
    transferInstallationOwner = mocks.transferInstallationOwner;
  },
}));

vi.mock("../../src/repositories/github-lifecycle", () => ({
  GitHubLifecycleRepository: class {
    findInstaller = mocks.findInstaller;
  },
}));

vi.mock("../../src/services/github-app", async (original) => ({
  ...(await original<typeof import("../../src/services/github-app")>()),
  exchangeUserAuthorizationCode: mocks.exchangeUserAuthorizationCode,
  findUserInstallation: mocks.findUserInstallation,
  listUserInstallationRepositories: mocks.listUserInstallationRepositories,
  fetchGitHubTokenUser: mocks.fetchGitHubTokenUser,
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
      accountId: "900",
      accountLogin: "acme",
      accountType: "Organization",
    });
    mocks.fetchGitHubTokenUser.mockResolvedValue({ githubUserId: "5150", login: "octo-admin" });
    mocks.findInstallationOwner.mockResolvedValue(null);
    mocks.findInstaller.mockResolvedValue({ githubUserId: "5150", login: "octo-admin" });
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

  describe("organization install owner (Decision 6)", () => {
    test("authorize accepts the GitHub user who installed the app", async () => {
      const { state, nonce } = await startAuthorization("4242");

      const response = await authorize(state, nonce);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://doxa.so/dashboard?github=connected");
      expect(mocks.fetchGitHubTokenUser).toHaveBeenCalledWith("ghu_user");
      expect(mocks.findInstaller).toHaveBeenCalledWith("4242");
      expect(mocks.recordInstallation).toHaveBeenCalled();
    });

    test("authorize refuses an organization member who did not install the app", async () => {
      mocks.fetchGitHubTokenUser.mockResolvedValue({ githubUserId: "7777", login: "member" });
      const { state, nonce } = await startAuthorization("4242");

      const response = await authorize(state, nonce);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: expect.objectContaining({ message: expect.stringContaining("octo-admin") }),
      });
      expect(mocks.recordInstallation).not.toHaveBeenCalled();
      expect(mocks.recordRepository).not.toHaveBeenCalled();
    });

    test("authorize asks to try again while the installation webhook did not arrive", async () => {
      mocks.findInstaller.mockResolvedValue(null);
      const { state, nonce } = await startAuthorization("4242");

      const response = await authorize(state, nonce);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://doxa.so/dashboard?github=pending&installation_id=4242",
      );
      expect(response.headers.get("set-cookie")).toMatch(/doxa_github_install=; Path=\/github\/install; Max-Age=0/);
      expect(mocks.recordInstallation).not.toHaveBeenCalled();
    });

    test("authorize lets the recorded owner connect again without an installer record", async () => {
      mocks.findInstallationOwner.mockResolvedValue("user-1");
      mocks.findInstaller.mockResolvedValue(null);
      mocks.fetchGitHubTokenUser.mockResolvedValue({ githubUserId: "7777", login: "member" });
      const { state, nonce } = await startAuthorization("4242");

      const response = await authorize(state, nonce);

      expect(response.status).toBe(302);
      expect(mocks.recordInstallation).toHaveBeenCalled();
    });

    test("authorize refuses the installer when another Doxa user owns the installation", async () => {
      mocks.findInstallationOwner.mockResolvedValue("user-2");
      const { state, nonce } = await startAuthorization("4242");

      const response = await authorize(state, nonce);

      expect(response.status).toBe(409);
      expect(mocks.recordInstallation).not.toHaveBeenCalled();
    });

    test("a user account installation needs the GitHub user who owns the account", async () => {
      mocks.findUserInstallation.mockResolvedValue({
        installationId: "4242",
        accountId: "900",
        accountLogin: "alice",
        accountType: "User",
      });
      mocks.findInstaller.mockResolvedValue(null);
      const refused = await startAuthorization("4242");
      expect((await authorize(refused.state, refused.nonce)).status).toBe(403);
      expect(mocks.recordInstallation).not.toHaveBeenCalled();

      mocks.fetchGitHubTokenUser.mockResolvedValue({ githubUserId: "900", login: "alice" });
      const accepted = await startAuthorization("4242");
      expect((await authorize(accepted.state, accepted.nonce)).status).toBe(302);
      expect(mocks.recordInstallation).toHaveBeenCalled();
    });

    test("authorize answers 502 when GitHub cannot name the user", async () => {
      mocks.fetchGitHubTokenUser.mockRejectedValue(new Error("GitHub user request failed (500)."));
      const { state, nonce } = await startAuthorization("4242");

      expect((await authorize(state, nonce)).status).toBe(502);
      expect(mocks.recordInstallation).not.toHaveBeenCalled();
    });
  });

  describe("installation owner transfer", () => {
    const rowId = "0b6f3f8e-2a51-4f4e-9a63-6b1f6f2f0a11";
    const transfer = (body: unknown, id = rowId) =>
      request(`/installations/${id}/owner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    test("the owner moves an installation to a team member", async () => {
      mocks.transferInstallationOwner.mockResolvedValue("moved");

      const response = await transfer({ userId: "user-2" });

      expect(response.status).toBe(200);
      expect(mocks.transferInstallationOwner).toHaveBeenCalledWith({
        installationRowId: rowId,
        fromUserId: "user-1",
        toUserId: "user-2",
      });
    });

    test("a user who does not own the installation gets 404", async () => {
      mocks.transferInstallationOwner.mockResolvedValue("not_found");

      expect((await transfer({ userId: "user-2" })).status).toBe(404);
    });

    test("a target outside the owner's teams is refused", async () => {
      mocks.transferInstallationOwner.mockResolvedValue("target_not_allowed");

      expect((await transfer({ userId: "stranger" })).status).toBe(403);
    });

    test("a bad installation id or body is refused before any change", async () => {
      expect((await transfer({ userId: "user-2" }, "not-a-uuid")).status).toBe(404);
      expect((await transfer({})).status).toBe(400);
      expect(mocks.transferInstallationOwner).not.toHaveBeenCalled();
    });

    test("lists the owner's installations and the transfer targets", async () => {
      mocks.listInstallationsForOwner.mockResolvedValue([
        { id: rowId, accountLogin: "acme", accountType: "Organization", status: "active" },
      ]);
      mocks.listOwnerTransferTargets.mockResolvedValue([
        { userId: "user-2", name: "Bea", email: "bea@example.com" },
      ]);

      const response = await request("/installations");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        installations: [{ id: rowId, accountLogin: "acme", accountType: "Organization", status: "active" }],
        transferTargets: [{ userId: "user-2", name: "Bea", email: "bea@example.com" }],
      });
      expect(mocks.listInstallationsForOwner).toHaveBeenCalledWith("user-1");
    });
  });
});

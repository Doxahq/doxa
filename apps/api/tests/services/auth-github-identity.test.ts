import {
  createAuth,
  syncGitHubAccountIdentity,
  type GitHubIdentityStore,
} from "@doxahq/auth";
import { describe, expect, test, vi } from "vitest";

const authEnv = {
  DATABASE_URL: "postgres://user:password@127.0.0.1:5432/doxa",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:8787",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

const productionAuthEnv = {
  ...authEnv,
  BETTER_AUTH_URL: "https://api.doxa.so",
  WEB_ORIGIN: "https://doxa.so",
  AUTH_COOKIE_DOMAIN: ".doxa.so",
};

function identityStore(): GitHubIdentityStore {
  return {
    linkGenerations: vi.fn(async () => {}),
    updateUserProfile: vi.fn(async () => {}),
  };
}

describe("auth cookie scope", () => {
  test("shares production auth cookies with the dashboard domain", () => {
    const auth = createAuth(productionAuthEnv);

    expect(auth.options.advanced?.crossSubDomainCookies).toEqual({
      enabled: true,
      domain: ".doxa.so",
    });
  });

  test("keeps local auth cookies host-only", () => {
    const auth = createAuth(authEnv);

    expect(auth.options.advanced?.crossSubDomainCookies).toBeUndefined();
  });
});

describe("GitHub account identity synchronization", () => {
  test("does not accept githubLogin as user input", () => {
    const auth = createAuth(authEnv);

    expect(
      auth.options.user?.additionalFields?.githubLogin,
    ).toMatchObject({ input: false });
  });

  test("ignores accounts from other providers", async () => {
    const store = identityStore();
    const fetchRequest = vi.fn<typeof fetch>();

    await syncGitHubAccountIdentity({
      account: {
        providerId: "google",
        accountId: "google-account",
        userId: "user-1",
        accessToken: "google-token",
      },
      store,
      fetchRequest,
    });

    expect(store.linkGenerations).not.toHaveBeenCalled();
    expect(store.updateUserProfile).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("links past generations before profile refresh", async () => {
    const store = identityStore();
    const fetchRequest = vi.fn<typeof fetch>();

    await syncGitHubAccountIdentity({
      account: {
        providerId: "github",
        accountId: "1",
        userId: "user-1",
        accessToken: null,
      },
      store,
      fetchRequest,
    });

    expect(store.linkGenerations).toHaveBeenCalledWith({
      externalId: "1",
      userId: "user-1",
    });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  test("refreshes the protected login from the authenticated GitHub profile", async () => {
    const store = identityStore();
    const fetchRequest = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 1,
        login: "octocat-renamed",
        avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      }),
    );

    await syncGitHubAccountIdentity({
      account: {
        providerId: "github",
        accountId: "1",
        userId: "user-1",
        accessToken: "github-user-token",
      },
      store,
      fetchRequest,
    });

    expect(fetchRequest).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/vnd.github+json",
          authorization: "Bearer github-user-token",
        }),
      }),
    );
    expect(store.updateUserProfile).toHaveBeenCalledWith({
      userId: "user-1",
      login: "octocat-renamed",
    });
  });

  test("rejects a token for a different GitHub account", async () => {
    const store = identityStore();

    await expect(
      syncGitHubAccountIdentity({
        account: {
          providerId: "github",
          accountId: "1",
          userId: "user-1",
          accessToken: "wrong-account-token",
        },
        store,
        fetchRequest: vi.fn<typeof fetch>(async () =>
          Response.json({
            id: 2,
            login: "not-octocat",
            avatar_url: "https://avatars.githubusercontent.com/u/2?v=4",
          }),
        ),
      }),
    ).rejects.toThrow(
      "GitHub profile does not match the linked account.",
    );
    expect(store.updateUserProfile).not.toHaveBeenCalled();
  });
});

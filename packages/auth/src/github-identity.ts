const GITHUB_API_USER_URL = "https://api.github.com/user";

export interface GitHubAuthAccount {
  providerId: string;
  accountId: string;
  userId: string;
  accessToken?: string | null;
}

export interface GitHubIdentityStore {
  linkGenerations(input: {
    externalId: string;
    userId: string;
  }): Promise<void>;
  updateUserProfile(input: {
    userId: string;
    login: string;
  }): Promise<void>;
}

export async function syncGitHubAccountIdentity(input: {
  account: GitHubAuthAccount;
  store: GitHubIdentityStore;
  fetchRequest?: typeof fetch;
}): Promise<void> {
  if (input.account.providerId !== "github") return;

  await input.store.linkGenerations({
    externalId: input.account.accountId,
    userId: input.account.userId,
  });

  if (!input.account.accessToken) return;

  const profile = await fetchGitHubProfile(
    input.account.accessToken,
    input.fetchRequest ?? fetch,
  );
  if (profile.externalId !== input.account.accountId) {
    throw new Error("GitHub profile does not match the linked account.");
  }

  await input.store.updateUserProfile({
    userId: input.account.userId,
    login: profile.login,
  });
}

async function fetchGitHubProfile(
  accessToken: string,
  fetchRequest: typeof fetch,
): Promise<{ externalId: string; login: string }> {
  const response = await fetchRequest(GITHUB_API_USER_URL, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "doxa-platform",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub profile lookup failed (${response.status}).`);
  }

  const value: unknown = await response.json();
  if (!isGitHubProfile(value)) {
    throw new Error("GitHub profile response is invalid.");
  }

  return {
    externalId: String(value.id),
    login: value.login,
  };
}

function isGitHubProfile(
  value: unknown,
): value is { id: number; login: string } {
  if (!value || typeof value !== "object") return false;
  if (!("id" in value) || !("login" in value)) return false;

  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.login === "string" &&
    value.login.trim().length > 0
  );
}

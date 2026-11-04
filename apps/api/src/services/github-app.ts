import type { Env } from "../env";

interface InstallationTokenResponse {
  token?: string;
  expires_at?: string;
}

interface InstallationRepositoriesResponse {
  repositories?: Array<{
    id: number;
    full_name: string;
    name: string;
    private: boolean;
    default_branch?: string;
    owner?: {
      login?: string;
    };
  }>;
}

interface UserTokenResponse {
  access_token?: string;
  error?: string;
}

interface UserInstallationsResponse {
  installations?: Array<{
    id: number;
    account?: {
      login?: string;
      type?: string;
    } | null;
  }>;
}

export interface InstallationAccessToken {
  token: string;
  expiresAt: string | null;
}

export interface InstallationAccessTokenScope {
  repositoryIds: number[];
  permissions: Record<string, "read" | "write">;
}

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_PAGE_SIZE = 100;
const MAX_USER_INSTALLATION_PAGES = 10;
const MAX_USER_REPOSITORY_PAGES = 50;

/** Local development uses `LOCAL_GITHUB_TOKEN` instead of a GitHub App installation. */
export function isLocalInstallation(installationId: string): boolean {
  return installationId.startsWith("local");
}

export async function createInstallationAccessToken(
  env: Env,
  installationId: string,
  scope?: InstallationAccessTokenScope,
): Promise<InstallationAccessToken> {
  if (isLocalInstallation(installationId)) {
    const token = env.LOCAL_GITHUB_TOKEN;
    if (!token) {
      throw new Error("LOCAL_GITHUB_TOKEN is required for local repository generation.");
    }
    return { token, expiresAt: null };
  }

  const appJwt = await createGitHubAppJwt(env);
  const body = scope ? scopedTokenBody(scope) : undefined;
  const response = await fetch(`${GITHUB_API_BASE_URL}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(`Bearer ${appJwt}`),
    body,
  });

  if (!response.ok) {
    throw new Error(`GitHub installation token request failed (${response.status}).`);
  }

  const payload = (await response.json()) as InstallationTokenResponse;
  if (!payload.token) {
    throw new Error("GitHub installation token response did not include a token.");
  }

  return {
    token: payload.token,
    expiresAt: payload.expires_at ?? null,
  };
}

function scopedTokenBody(scope: InstallationAccessTokenScope): string {
  if (
    scope.repositoryIds.length === 0 ||
    scope.repositoryIds.some(
      (repositoryId) =>
        !Number.isSafeInteger(repositoryId) || repositoryId <= 0,
    )
  ) {
    throw new Error(
      "A scoped GitHub installation token requires valid repository IDs.",
    );
  }

  return JSON.stringify({
    repository_ids: scope.repositoryIds,
    permissions: scope.permissions,
  });
}

export async function listInstallationRepositories(token: string) {
  const response = await fetch(`${GITHUB_API_BASE_URL}/installation/repositories?per_page=100`, {
    headers: githubHeaders(`Bearer ${token}`),
  });

  if (!response.ok) {
    throw new Error(`GitHub installation repositories request failed (${response.status}).`);
  }

  const payload = (await response.json()) as InstallationRepositoriesResponse;
  return (payload.repositories ?? []).map(toRepositoryRecord);
}

export interface UserInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/**
 * Exchanges the `code` of the GitHub App web flow for a user access token.
 * `redirectUri` must be the one that the authorize request used.
 */
export async function exchangeUserAuthorizationCode(
  env: Pick<Env, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">,
  code: string,
  redirectUri: string,
): Promise<string> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub App authorization.");
  }

  const response = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "doxa-platform",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub user authorization request failed (${response.status}).`);
  }

  // GitHub answers 200 with an `error` field when the code is bad or used.
  const payload = (await response.json()) as UserTokenResponse;
  if (!payload.access_token) {
    throw new GitHubAuthorizationError(payload.error ?? "missing_token");
  }

  return payload.access_token;
}

/**
 * The installation as the user's own token sees it, or null when the user
 * cannot access it. GitHub lists only the installations of this App that the
 * user has explicit permission to access.
 */
export async function findUserInstallation(
  userToken: string,
  installationId: string,
): Promise<UserInstallation | null> {
  for (let page = 1; page <= MAX_USER_INSTALLATION_PAGES; page += 1) {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/user/installations?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      { headers: githubHeaders(`Bearer ${userToken}`) },
    );
    if (!response.ok) {
      throw new Error(`GitHub user installations request failed (${response.status}).`);
    }

    const payload = (await response.json()) as UserInstallationsResponse;
    const installations = payload.installations ?? [];
    const match = installations.find((installation) => String(installation.id) === installationId);
    if (match) {
      return {
        installationId: String(match.id),
        accountLogin: match.account?.login ?? "unknown",
        accountType: match.account?.type ?? "User",
      };
    }
    if (installations.length < GITHUB_PAGE_SIZE) return null;
  }

  return null;
}

export type InstallationRepositoryRecord = ReturnType<typeof toRepositoryRecord>;

export interface UserInstallationRepositories {
  repositories: InstallationRepositoryRecord[];
  /**
   * False when the list stopped at the page cap. Then a repository missing
   * from it can still be one that the user can access.
   */
  complete: boolean;
}

/** The repositories of the installation that this user can access. */
export async function listUserInstallationRepositories(
  userToken: string,
  installationId: string,
): Promise<UserInstallationRepositories> {
  const repositories: InstallationRepositoryRecord[] = [];
  for (let page = 1; page <= MAX_USER_REPOSITORY_PAGES; page += 1) {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      { headers: githubHeaders(`Bearer ${userToken}`) },
    );
    if (!response.ok) {
      throw new Error(`GitHub user installation repositories request failed (${response.status}).`);
    }

    const payload = (await response.json()) as InstallationRepositoriesResponse;
    const pageRepositories = payload.repositories ?? [];
    repositories.push(...pageRepositories.map(toRepositoryRecord));
    if (pageRepositories.length < GITHUB_PAGE_SIZE) return { repositories, complete: true };
  }

  return { repositories, complete: false };
}

/** The code exchange failed at GitHub, for example because the code expired. */
export class GitHubAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(`GitHub user authorization failed (${code}).`);
    this.name = "GitHubAuthorizationError";
  }
}

function toRepositoryRecord(repo: NonNullable<InstallationRepositoriesResponse["repositories"]>[number]) {
  return {
    githubRepoId: String(repo.id),
    fullName: repo.full_name,
    owner: repo.owner?.login ?? repo.full_name.split("/")[0] ?? "unknown",
    name: repo.name,
    defaultBranch: repo.default_branch ?? "main",
    isPrivate: repo.private,
  };
}

async function createGitHubAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for GitHub App access.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.GITHUB_APP_ID,
  });
  const input = `${header}.${payload}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(input),
  );

  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const body = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binary = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  const keyData = isPkcs1 ? wrapPkcs1RsaPrivateKey(binary) : binary;
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(keyData),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function wrapPkcs1RsaPrivateKey(pkcs1: Uint8Array): Uint8Array {
  const rsaEncryptionOid = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = derEncode(0x04, pkcs1);
  return derEncode(0x30, concatBytes(version, rsaEncryptionOid, privateKey));
}

function derEncode(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);

  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function githubHeaders(authorization: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": "doxa-platform",
    "x-github-api-version": "2022-11-28",
  };
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

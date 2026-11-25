import type { Env } from "../env";
import { isGitHubRateLimited } from "./github-rate-limit";

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
      id?: number;
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

/**
 * GitHub refused an installation token. The status and the rate-limit signal
 * tell a lost installation from an outage or a rate limit.
 */
export class InstallationTokenRequestError extends Error {
  constructor(readonly status: number, readonly rateLimited = false) {
    super(`GitHub installation token request failed (${status}${rateLimited ? ", rate limited" : ""}).`);
    this.name = "InstallationTokenRequestError";
  }
}

/** The statuses with which GitHub refuses a token for good, unless the answer is a rate limit. */
const LOST_INSTALLATION_STATUSES: readonly number[] = [401, 403, 404, 422];

/**
 * Whether GitHub refused a token for good: the app was uninstalled (404),
 * suspended or lost a permission (401, 403), or the repository is no longer
 * in the installation (422). A 403 rate limit passes, so it is not one.
 */
export function isLostInstallationAccess(error: unknown): boolean {
  return error instanceof InstallationTokenRequestError
    && !error.rateLimited
    && LOST_INSTALLATION_STATUSES.includes(error.status);
}

/**
 * A short-lived GitHub token limited to `scope`. Doxa never asks GitHub for a
 * token that covers every repository of an installation. Only a local
 * installation takes no scope: it uses one developer token, which cannot be
 * scoped.
 */
export async function createInstallationAccessToken(
  env: Env,
  installationId: string,
  scope: InstallationAccessTokenScope | null,
): Promise<InstallationAccessToken> {
  if (isLocalInstallation(installationId)) {
    const token = env.LOCAL_GITHUB_TOKEN;
    if (!token) {
      throw new Error("LOCAL_GITHUB_TOKEN is required for local repository generation.");
    }
    return { token, expiresAt: null };
  }
  if (!scope) {
    throw new Error("A GitHub installation token must be limited to repositories.");
  }

  const appJwt = await createGitHubAppJwt(env);
  const body = scopedTokenBody(scope);
  const response = await fetch(`${GITHUB_API_BASE_URL}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(`Bearer ${appJwt}`),
    body,
  });

  if (!response.ok) {
    throw new InstallationTokenRequestError(response.status, await isGitHubRateLimited(response));
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
  /** The GitHub ID of the user or organization that has the installation. */
  accountId: string | null;
  accountLogin: string;
  accountType: string;
}

/** The GitHub user that a user token belongs to. */
export interface GitHubTokenUser {
  githubUserId: string;
  login: string;
}

/**
 * The GitHub user of a user token. The install flow uses it to prove which
 * GitHub account the Doxa user controls now: a Doxa account does not need a
 * linked GitHub sign-in.
 */
export async function fetchGitHubTokenUser(userToken: string): Promise<GitHubTokenUser> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: githubHeaders(`Bearer ${userToken}`),
  });
  if (!response.ok) {
    throw new Error(`GitHub user request failed (${response.status}).`);
  }
  const payload = (await response.json()) as { id?: number; login?: string };
  if (typeof payload.id !== "number" || !payload.login) {
    throw new Error("GitHub user response has no id.");
  }
  return { githubUserId: String(payload.id), login: payload.login };
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
        accountId: typeof match.account?.id === "number" ? String(match.account.id) : null,
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
   * False when the list stopped at the page cap or at the rate limit floor.
   * Then a repository missing from it can still be one that the user can
   * access.
   */
  complete: boolean;
}

export interface ListUserInstallationRepositoriesOptions {
  /**
   * Stop before the next page when fewer requests than this are left in the
   * user's hourly GitHub budget (`x-ratelimit-remaining`). GitHub shares that
   * budget with every app and token of the user. Absent: no floor.
   */
  minRateLimitRemaining?: number;
}

/** GitHub refused the repository list of a user token. */
export class GitHubRepositoryListError extends Error {
  constructor(
    readonly status: number,
    readonly rateLimited: boolean,
    /** Seconds until the limit resets, when GitHub says so. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`GitHub user installation repositories request failed (${status}${rateLimited ? ", rate limited" : ""}).`);
    this.name = "GitHubRepositoryListError";
  }

  /** The token cannot read the list: revoked, expired, or not a token of this app. */
  get isAuthorizationRefusal(): boolean {
    return !this.rateLimited && (this.status === 401 || this.status === 403 || this.status === 404);
  }
}

/**
 * The repositories of the installation that this user can access. Pages are
 * read one after another, at most {@link MAX_USER_REPOSITORY_PAGES} of them.
 */
export async function listUserInstallationRepositories(
  userToken: string,
  installationId: string,
  options: ListUserInstallationRepositoriesOptions = {},
): Promise<UserInstallationRepositories> {
  const repositories: InstallationRepositoryRecord[] = [];
  for (let page = 1; page <= MAX_USER_REPOSITORY_PAGES; page += 1) {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      { headers: githubHeaders(`Bearer ${userToken}`) },
    );
    if (!response.ok) {
      const rateLimited = await isGitHubRateLimited(response);
      throw new GitHubRepositoryListError(
        response.status,
        rateLimited,
        rateLimited ? retryAfterSeconds(response) : null,
      );
    }

    const payload = (await response.json()) as InstallationRepositoriesResponse;
    const pageRepositories = payload.repositories ?? [];
    repositories.push(...pageRepositories.map(toRepositoryRecord));
    if (pageRepositories.length < GITHUB_PAGE_SIZE) return { repositories, complete: true };
    if (belowRateLimitFloor(response, options.minRateLimitRemaining)) return { repositories, complete: false };
  }

  return { repositories, complete: false };
}

function belowRateLimitFloor(response: Response, floor: number | undefined): boolean {
  if (floor === undefined) return false;
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  return Number.isFinite(remaining) && remaining < floor;
}

/** From `retry-after`, else from `x-ratelimit-reset` (epoch seconds). Null when GitHub gives neither. */
function retryAfterSeconds(response: Response, nowMs = Date.now()): number | null {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - nowMs / 1000));
  return null;
}

/**
 * The default branch of one repository, read with a token limited to that
 * repository and to metadata. For an event that names a repository without
 * its branch (`installation_repositories`). Costs two GitHub requests: the
 * token and the read. Null when GitHub does not return a branch.
 */
export async function fetchRepositoryDefaultBranch(
  env: Env,
  installationId: string,
  repositoryId: string,
): Promise<string | null> {
  const numericId = Number(repositoryId);
  const { token } = await createInstallationAccessToken(env, installationId, {
    repositoryIds: [numericId],
    permissions: { metadata: "read" },
  });
  const response = await fetch(`${GITHUB_API_BASE_URL}/repositories/${encodeURIComponent(repositoryId)}`, {
    headers: githubHeaders(`Bearer ${token}`),
  });
  if (!response.ok) {
    throw new Error(`GitHub repository request failed (${response.status}).`);
  }
  const payload = (await response.json()) as { default_branch?: unknown };
  return typeof payload.default_branch === "string" && payload.default_branch.length > 0
    ? payload.default_branch
    : null;
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

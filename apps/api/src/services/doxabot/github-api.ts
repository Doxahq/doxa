export const GITHUB_API_BASE_URL = "https://api.github.com";

export function githubApiHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "doxa-platform",
    "x-github-api-version": "2022-11-28",
  };
}

export function parseGitHubRepositoryId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("GitHub repository ID must be a positive integer.");
  }

  const repositoryId = Number(value);
  if (!Number.isSafeInteger(repositoryId)) {
    throw new Error(
      "GitHub repository ID exceeds the supported integer range.",
    );
  }
  return repositoryId;
}

const GITHUB_ORIGIN = "https://github.com";

export function createGitHubRepositoryUrl(
  repositoryFullName: string,
): string | null {
  const path = getRepositoryPath(repositoryFullName);
  return path ? `${GITHUB_ORIGIN}/${path}` : null;
}

export function createGitHubCommitUrl(
  repositoryFullName: string,
  revision: string,
): string | null {
  const repositoryUrl = createGitHubRepositoryUrl(repositoryFullName);
  return repositoryUrl
    ? `${repositoryUrl}/commit/${encodeURIComponent(revision)}`
    : null;
}

export function createGitHubBranchUrl(
  repositoryFullName: string,
  branch: string,
): string | null {
  const repositoryUrl = createGitHubRepositoryUrl(repositoryFullName);
  // A branch name can hold slashes, which GitHub reads as part of the name.
  const path = branch.split("/").map(encodeURIComponent).join("/");
  return repositoryUrl ? `${repositoryUrl}/tree/${path}` : null;
}

export function createGitHubPullRequestUrl(
  repositoryFullName: string,
  number: number,
): string | null {
  const repositoryUrl = createGitHubRepositoryUrl(repositoryFullName);
  return repositoryUrl ? `${repositoryUrl}/pull/${number}` : null;
}

function getRepositoryPath(repositoryFullName: string): string | null {
  const segments = repositoryFullName.split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

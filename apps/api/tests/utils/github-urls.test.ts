import { describe, expect, test } from "vitest";
import {
  createGitHubBranchUrl,
  createGitHubCommitUrl,
  createGitHubPullRequestUrl,
  createGitHubRepositoryUrl,
} from "../../src/utils/github-urls";

describe("GitHub URLs", () => {
  test("encodes repository path segments and source identifiers", () => {
    expect(createGitHubRepositoryUrl("doxa/demo docs")).toBe(
      "https://github.com/doxa/demo%20docs",
    );
    expect(createGitHubCommitUrl("doxa/demo docs", "abc/123")).toBe(
      "https://github.com/doxa/demo%20docs/commit/abc%2F123",
    );
    expect(createGitHubPullRequestUrl("doxa/demo docs", 42)).toBe(
      "https://github.com/doxa/demo%20docs/pull/42",
    );
  });

  test("keeps the slashes of a branch name in its URL", () => {
    expect(createGitHubBranchUrl("doxa/demo", "feature/new docs")).toBe(
      "https://github.com/doxa/demo/tree/feature/new%20docs",
    );
    expect(createGitHubBranchUrl("demo", "main")).toBeNull();
  });

  test("rejects repository names that do not contain an owner and name", () => {
    expect(createGitHubRepositoryUrl("demo")).toBeNull();
    expect(createGitHubCommitUrl("demo", "abc123")).toBeNull();
    expect(createGitHubPullRequestUrl("demo", 1)).toBeNull();
  });
});

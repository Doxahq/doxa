import { describe, expect, test } from "vitest";
import {
  generationDetailSchema,
  promoteGenerationResultSchema,
} from "@doxahq/contracts";

const generationDetail = {
  id: "job-1",
  projectId: "project-1",
  status: "succeeded",
  docsVersionId: "version-1",
  errorMessage: null,
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:02:00.000Z",
  trigger: "manual",
  author: {
    kind: "user",
    displayName: "octocat",
    githubLogin: "octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  source: {
    provider: "github",
    repositoryFullName: "doxa/demo",
    repositoryUrl: "https://github.com/doxa/demo",
    branch: "main",
    branchUrl: "https://github.com/doxa/demo/tree/main",
    commit: {
      revision: "1234567890abcdef1234567890abcdef12345678",
      shortRevision: "1234567",
      url: "https://github.com/doxa/demo/commit/1234567890abcdef1234567890abcdef12345678",
      message: null,
    },
    changeProposal: null,
  },
  deployment: {
    environment: "production",
    isCurrent: true,
    state: "live",
    docsVersionId: "version-1",
    versionNumber: 3,
    visitUrl: "https://docs.example.com",
    domains: [
      {
        hostname: "docs.example.com",
        url: "https://docs.example.com",
        role: "production",
      },
    ],
  },
  actions: {
    canPromote: false,
    canDelete: false,
    canRerun: false,
    promoteBlockedReason: "already_production",
    deleteBlockedReason: "serving_production",
    rerunBlockedReason: "not_finished",
    canResume: false,
    resumeBlockedReason: "not_resumable",
  },
  rerunLinks: { rerunOfId: null, rerunId: null },
  flaggedPages: [],
  referenceSource: null,
} as const;

describe("generation detail contracts", () => {
  test("accepts a complete generation detail response", () => {
    expect(generationDetailSchema.parse(generationDetail)).toEqual(
      generationDetail,
    );
  });

  test("accepts a promotion result with the new production version", () => {
    const result = {
      generation: generationDetail,
      publishedVersionId: "version-2",
    };

    expect(promoteGenerationResultSchema.parse(result)).toEqual(result);
  });
});

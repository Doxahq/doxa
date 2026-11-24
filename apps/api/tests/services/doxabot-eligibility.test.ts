import { describe, expect, test } from "vitest";
import {
  evaluateDoxabotEligibility,
  resolveDoxabotDeploymentPolicy,
  type EvaluateDoxabotEligibilityInput,
} from "../../src/services/doxabot/eligibility";

const eligiblePrivateProject: EvaluateDoxabotEligibilityInput = {
  deploymentPolicy: {
    enabled: true,
    publicRepositoriesEnabled: false,
  },
  repository: {
    connected: true,
    visibility: "private",
  },
  hasPublishedVersion: true,
  storedEnabled: true,
};

interface EligibilityTestCase {
  name: string;
  input: EvaluateDoxabotEligibilityInput;
  expected: ReturnType<typeof evaluateDoxabotEligibility>;
}

const eligibilityCases: EligibilityTestCase[] = [
    {
      name: "global shutdown overrides an otherwise enabled project",
      input: {
        ...eligiblePrivateProject,
        deploymentPolicy: {
          enabled: false,
          publicRepositoriesEnabled: true,
        },
      },
      expected: {
        available: false,
        enabled: false,
        reason: "global_disabled",
      },
    },
    {
      name: "a repository that GitHub took away is not connected",
      input: {
        ...eligiblePrivateProject,
        repository: { connected: true, visibility: "private", connectionIssue: "installation_suspended" },
      },
      expected: {
        available: false,
        enabled: false,
        reason: "repository_not_connected",
      },
    },
    {
      name: "a repository must be connected",
      input: {
        ...eligiblePrivateProject,
        repository: { connected: false },
      },
      expected: {
        available: false,
        enabled: false,
        reason: "repository_not_connected",
      },
    },
    {
      name: "public repositories are denied by default",
      input: {
        ...eligiblePrivateProject,
        repository: {
          connected: true,
          visibility: "public",
        },
      },
      expected: {
        available: false,
        enabled: false,
        reason: "public_repository_disabled",
      },
    },
    {
      name: "an initial published generation is required",
      input: {
        ...eligiblePrivateProject,
        hasPublishedVersion: false,
      },
      expected: {
        available: false,
        enabled: false,
        reason: "initial_generation_required",
      },
    },
    {
      name: "eligible private repositories preserve their stored setting",
      input: eligiblePrivateProject,
      expected: {
        available: true,
        enabled: true,
        reason: null,
      },
    },
    {
      name: "eligible disabled projects remain available but disabled",
      input: {
        ...eligiblePrivateProject,
        storedEnabled: false,
      },
      expected: {
        available: true,
        enabled: false,
        reason: null,
      },
    },
    {
      name: "the future flag can make public repositories eligible",
      input: {
        ...eligiblePrivateProject,
        deploymentPolicy: {
          enabled: true,
          publicRepositoriesEnabled: true,
        },
        repository: {
          connected: true,
          visibility: "public",
        },
      },
      expected: {
        available: true,
        enabled: true,
        reason: null,
      },
    },
];

describe("Doxabot eligibility", () => {
  test.each(eligibilityCases)("$name", ({ input, expected }) => {
    expect(evaluateDoxabotEligibility(input)).toEqual(expected);
  });

  test("deployment flags default to disabled", () => {
    expect(resolveDoxabotDeploymentPolicy({})).toEqual({
      enabled: false,
      publicRepositoriesEnabled: false,
    });
  });

  test("deployment flags parse explicit true values", () => {
    expect(resolveDoxabotDeploymentPolicy({
      DOXABOT_ENABLED: "true",
      DOXABOT_PUBLIC_REPOSITORIES_ENABLED: " TRUE ",
    })).toEqual({
      enabled: true,
      publicRepositoriesEnabled: true,
    });
  });
});

import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_REPOSITORY_SIZE_KB,
  checkRepositorySize,
  maxRepositorySizeKbFromEnv,
} from "../../src/services/repository-size";

describe("repository size limit", () => {
  test("defaults to 1 GB and reads MAX_REPOSITORY_SIZE_KB", () => {
    expect(DEFAULT_MAX_REPOSITORY_SIZE_KB).toBe(1_048_576);
    expect(maxRepositorySizeKbFromEnv(undefined)).toBe(1_048_576);
    expect(maxRepositorySizeKbFromEnv({})).toBe(1_048_576);
    expect(maxRepositorySizeKbFromEnv({ MAX_REPOSITORY_SIZE_KB: " 512000 " })).toBe(512_000);
  });

  test("ignores a value that is not a positive integer", () => {
    for (const value of ["", "0", "-5", "1.5", "1GB", "abc"]) {
      expect(maxRepositorySizeKbFromEnv({ MAX_REPOSITORY_SIZE_KB: value })).toBe(1_048_576);
    }
  });

  test("refuses only a size above the limit", () => {
    expect(checkRepositorySize(undefined, 1_024)).toBeNull();
    expect(checkRepositorySize(1_024, 1_024)).toBeNull();
    expect(checkRepositorySize(1_536, 1_024)).toEqual({
      outcome: "repository_too_large",
      sizeKb: 1_536,
      limitKb: 1_024,
      message: "This repository is 1.5 MB. Doxa generates docs for repositories up to 1 MB.",
    });
    expect(checkRepositorySize(900, 512)?.message).toBe(
      "This repository is 900 KB. Doxa generates docs for repositories up to 512 KB.",
    );
  });
});

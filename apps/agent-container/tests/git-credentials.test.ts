import { access, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { createGitCredentialSession } from "../src/git-credentials";

const SENTINEL_TOKEN = "doxa-sentinel-token-42";

describe("Git credential session", () => {
  test("keeps the token in a child-only environment and removes its files", async () => {
    const session = await createGitCredentialSession(SENTINEL_TOKEN);
    const askpassPath = session.environment.GIT_ASKPASS;

    expect(askpassPath).toBeTruthy();
    if (!askpassPath) {
      throw new Error("Expected the credential session to provide GIT_ASKPASS.");
    }

    const directoryPath = dirname(askpassPath);
    const script = await readFile(askpassPath, "utf8");
    const directoryMode = (await stat(directoryPath)).mode & 0o777;
    const scriptMode = (await stat(askpassPath)).mode & 0o777;

    expect(session.environment.DOXA_GIT_TOKEN).toBe(SENTINEL_TOKEN);
    expect(session.environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(session.environment.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(session.environment.GIT_CONFIG_VALUE_0).toBe("");
    expect(session.environment.GIT_TRACE).toBeUndefined();
    expect(session.environment.GIT_TRACE_CURL).toBeUndefined();
    expect(session.environment.GIT_CURL_VERBOSE).toBeUndefined();
    expect(script).not.toContain(SENTINEL_TOKEN);
    expect(script).toContain("$DOXA_GIT_TOKEN");
    expect(directoryMode).toBe(0o700);
    expect(scriptMode).toBe(0o700);

    await session.dispose();
    await session.dispose();

    await expect(access(directoryPath)).rejects.toThrow();
  });

  test("removes inherited Git tracing from the credential child environment", async () => {
    const previousTrace = process.env.GIT_TRACE;
    const previousTraceCurl = process.env.GIT_TRACE_CURL;
    const previousCurlVerbose = process.env.GIT_CURL_VERBOSE;
    process.env.GIT_TRACE = "1";
    process.env.GIT_TRACE_CURL = "1";
    process.env.GIT_CURL_VERBOSE = "1";

    try {
      const session = await createGitCredentialSession(SENTINEL_TOKEN);
      try {
        expect(session.environment.GIT_TRACE).toBeUndefined();
        expect(session.environment.GIT_TRACE_CURL).toBeUndefined();
        expect(session.environment.GIT_CURL_VERBOSE).toBeUndefined();
      } finally {
        await session.dispose();
      }
    } finally {
      restoreEnvironment("GIT_TRACE", previousTrace);
      restoreEnvironment("GIT_TRACE_CURL", previousTraceCurl);
      restoreEnvironment("GIT_CURL_VERBOSE", previousCurlVerbose);
    }
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

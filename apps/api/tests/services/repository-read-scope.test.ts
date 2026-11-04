import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { repositoryReadScope } from "../../src/services/repository-read-access";
import { createInstallationAccessToken } from "../../src/services/github-app";

describe("generation repository read token scope", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("selects exactly one repository with read-only permissions", () => {
    expect(repositoryReadScope("123456")).toEqual({
      repositoryIds: [123456], permissions: { contents: "read", metadata: "read" },
    });
  });

  test.each(["", "0", "-1", "1.5", "123,456", "9007199254740992"])(
    "rejects invalid repository ID %j",
    (id) => expect(() => repositoryReadScope(id)).toThrow(),
  );

  test("sends the single-repository read scope to the GitHub token endpoint", async () => {
    // An ephemeral test signing key. It has no association with any GitHub App.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetchRequest = vi.fn(async () => Response.json({ token: "fake-installation-token" }));
    vi.stubGlobal("fetch", fetchRequest);
    await createInstallationAccessToken({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    } as never, "456", repositoryReadScope("789"));
    expect(fetchRequest).toHaveBeenCalledOnce();
    const [url, request] = fetchRequest.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({
      repository_ids: [789], permissions: { contents: "read", metadata: "read" },
    });
  });
});

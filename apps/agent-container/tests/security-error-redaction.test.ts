import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createLocalAgentServer } from "../src/local-http-server";
import {
  environmentSecrets,
  outputSecrets,
  redactOutputChunk,
  registerActiveSecrets,
  requestSecrets,
  sanitizeValue,
} from "../src/logging";

test("all request credentials are masked in nested diagnostic values", () => {
  const credentials = {
    installationAccessToken: `DOXA_CANARY_GIT_${randomBytes(16).toString("hex")}`,
    modelApiKey: `DOXA_CANARY_MODEL_${randomBytes(16).toString("hex")}`,
    modelAuthToken: `DOXA_CANARY_BEARER_${randomBytes(16).toString("hex")}`,
  };
  const result = sanitizeValue({ nested: Object.values(credentials).map((value) => ({ message: value })) }, requestSecrets(credentials));
  for (const value of Object.values(credentials)) expect(JSON.stringify(result)).not.toContain(value);
});

test("a generation HTTP error never returns a request credential", async () => {
  const secret = `DOXA_CANARY_MODEL_${randomBytes(16).toString("hex")}`;
  const server = createLocalAgentServer({
    generate: async () => { throw new Error(`Provider rejected ${secret}`); },
    streamGeneration: async () => {},
    streamGenerationStage: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "11111111-1111-4111-8111-111111111111",
        repositoryFullName: "local/security-fixture",
        installationAccessToken: "fake-git-token",
        modelProvider: "openrouter", modelApiKey: secret,
        siteId: "local-site", versionId: "local-version",
        projectSlug: "security-fixture", projectName: "Security Fixture",
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("process output masks the credentials of running requests only", () => {
  const secret = `DOXA_CANARY_BEARER_${randomBytes(16).toString("hex")}`;
  const line = `401 invalid token "Bearer ${secret}"\n`;
  const release = registerActiveSecrets([secret]);
  try {
    expect(redactOutputChunk(line)).not.toContain(secret);
    expect(String(redactOutputChunk(Buffer.from(line)))).not.toContain(secret);
  } finally {
    release();
  }
  expect(redactOutputChunk(line)).toBe(line);
});

test("output secrets include every environment value except public settings", () => {
  const value = `DOXA_CANARY_ENV_${randomBytes(16).toString("hex")}`;
  const env = {
    DOXA_CANARY_ENV: value,
    DOXA_FLAG: "true",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin",
    NODE_VERSION: "26.12.1-long-value",
    npm_package_json: "/app/apps/agent-container/package.json",
  };
  expect(environmentSecrets(env)).toEqual([value]);
  expect(outputSecrets({ installationAccessToken: "git-token-value", modelApiKey: undefined, modelAuthToken: undefined }, env))
    .toEqual(["git-token-value", value]);
});

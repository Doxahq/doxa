import { describe, expect, it, vi } from "vitest";
import { Agent, request } from "undici";
import { Redis } from "ioredis";
import { BackgroundTasks } from "../../../src/runtime/node/background-tasks";
import { ValkeyKvNamespace } from "../../../src/runtime/node/bindings/valkey-kv-namespace";
import { readApiVars, readServerConfig } from "../../../src/runtime/node/config";
import {
  BLOCKED_ADDRESS_CODE,
  createPublicOnlyConnector,
  isPublicAddress,
} from "../../../src/runtime/node/strict-public-fetch";

const STRONG = "s".repeat(40);

describe("BackgroundTasks", () => {
  it("waits for tasks, also tasks that a task adds", async () => {
    const tasks = new BackgroundTasks();
    const done: string[] = [];
    const context = tasks.createExecutionContext();

    context.waitUntil(
      (async () => {
        await Promise.resolve();
        context.waitUntil(new Promise<void>((resolve) => setTimeout(() => (done.push("child"), resolve()), 10)));
        done.push("parent");
      })(),
    );
    await tasks.settled();

    expect(done).toEqual(["parent", "child"]);
    expect(tasks.size).toBe(0);
  });

  it("logs a failed task and keeps going", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tasks = new BackgroundTasks();

    tasks.track(Promise.reject(new Error("boom")));
    await tasks.settled();

    expect(error).toHaveBeenCalledWith("A background task failed.", expect.any(Error));
    error.mockRestore();
  });

  it("stops waiting at the drain timeout", async () => {
    const tasks = new BackgroundTasks();
    tasks.track(new Promise(() => {}));

    await expect(tasks.drain(20)).resolves.toBe(false);
    expect(tasks.size).toBe(1);
  });
});

describe("ValkeyKvNamespace", () => {
  it("accepts only namespace names that are safe inside a hash tag", () => {
    const valkey = new Redis({ lazyConnect: true });

    expect(() => new ValkeyKvNamespace(valkey, "auth")).not.toThrow();
    expect(() => new ValkeyKvNamespace(valkey, "test-1")).not.toThrow();
    for (const namespace of ["", "Auth", "a}b", "{auth}", "a:b", "1auth"]) {
      expect(() => new ValkeyKvNamespace(valkey, namespace), namespace).toThrow(/lowercase letters/);
    }
    valkey.disconnect();
  });
});

describe("server config", () => {
  const base = {
    ORIGIN_SHARED_SECRET: STRONG,
    BRIDGE_URL: "https://api.doxa.so",
    BRIDGE_SHARED_SECRET: STRONG,
    VALKEY_URL: "rediss://cache.example:6379",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_BUCKET: "doxa-docs-artifacts-enam",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
  };

  it("reads production settings with safe defaults", () => {
    expect(readServerConfig(base)).toEqual({
      host: "127.0.0.1",
      port: 8786,
      originKey: STRONG,
      bridge: { baseUrl: "https://api.doxa.so", key: STRONG },
      valkeyUrl: "rediss://cache.example:6379",
      docsBucket: {
        kind: "s3",
        endpoint: "https://account.r2.cloudflarestorage.com",
        bucket: "doxa-docs-artifacts-enam",
        accessKeyId: "id",
        secretAccessKey: "secret",
      },
      pgPoolMax: 20,
      shutdownGraceMs: 110_000,
      strictPublicFetch: true,
    });
  });

  it("fails start-up on a weak key or a missing R2 setting", () => {
    expect(() => readServerConfig({ ...base, ORIGIN_SHARED_SECRET: "short" })).toThrow(/ORIGIN_SHARED_SECRET/);
    expect(() => readServerConfig({ ...base, R2_BUCKET: undefined })).toThrow(/R2_BUCKET is required/);
    expect(() => readServerConfig({ ...base, SHUTDOWN_GRACE_MS: "200000" })).toThrow();
  });

  it("listens on loopback unless HOST names another IP address", () => {
    expect(readServerConfig({ ...base, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(readServerConfig({ ...base, HOST: "::1" }).host).toBe("::1");
    for (const host of ["localhost", "evil.example", "0.0.0.0:8786", ""]) {
      expect(() => readServerConfig({ ...base, HOST: host }), host).toThrow();
    }
  });

  it("reads the local docs bucket settings for development", () => {
    const config = readServerConfig({
      ...base,
      DOCS_BUCKET_SOURCE: "local",
      WRANGLER_CONFIG_PATH: "/repo/apps/api/wrangler.json",
      WRANGLER_PERSIST_PATH: "/repo/.wrangler/state/v3",
      STRICT_PUBLIC_FETCH: "false",
    });

    expect(config.docsBucket).toEqual({
      kind: "local",
      wranglerConfigPath: "/repo/apps/api/wrangler.json",
      persistPath: "/repo/.wrangler/state/v3",
    });
    expect(config.strictPublicFetch).toBe(false);
  });
});

describe("API vars", () => {
  const required = {
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "https://api.doxa.so",
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "g",
    GITHUB_CLIENT_ID: "h",
    GITHUB_CLIENT_SECRET: "h",
    DATABASE_URL: "postgresql://localhost/doxa",
  };

  it("keeps server-only settings out of the API env", () => {
    const vars = readApiVars({
      ...required,
      ORIGIN_SHARED_SECRET: "o".repeat(40),
      BRIDGE_SHARED_SECRET: "b".repeat(40),
      R2_SECRET_ACCESS_KEY: "secret",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x",
      HOST: "127.0.0.1",
      WEB_ORIGIN: "https://doxa.so",
    });

    for (const name of ["ORIGIN_SHARED_SECRET", "BRIDGE_SHARED_SECRET", "R2_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "HOST"]) {
      expect(name in vars, name).toBe(false);
    }
    expect(vars.WEB_ORIGIN).toBe("https://doxa.so");
  });

  it("keeps string variables and drops other values", () => {
    const vars = readApiVars({ ...required, WEB_ORIGIN: "https://doxa.so", DOCS_BUCKET: { binding: true } });

    expect(vars.WEB_ORIGIN).toBe("https://doxa.so");
    expect("DOCS_BUCKET" in vars).toBe(false);
  });

  it("rejects a missing secret and an unknown generation mode", () => {
    expect(() => readApiVars({ ...required, BETTER_AUTH_SECRET: "" })).toThrow();
    expect(() => readApiVars({ ...required, GENERATION_MODE: "fast" })).toThrow();
  });
});

describe("strict public fetch", () => {
  it.each([
    ["8.8.8.8", true],
    ["104.16.0.1", true],
    ["2606:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.31.0.1", false],
    ["192.168.1.1", false],
    ["169.254.170.2", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["::ffff:7f00:1", false],
    ["::ffff:a9fe:aa02", false],
    ["::ffff:808:808", true],
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::1", false],
    ["::7f00:1", false],
    ["not-an-ip", false],
  ])("treats %s as public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("refuses a connection to a loopback IP and to a name that resolves to one", async () => {
    const dispatcher = new Agent({ connect: createPublicOnlyConnector() });
    try {
      for (const url of ["http://127.0.0.1:65530/", "http://[::1]:65530/", "http://localhost:65530/"]) {
        const failure = await request(url, { dispatcher }).catch((cause: unknown) => cause);
        expect(failure, url).toMatchObject({ code: BLOCKED_ADDRESS_CODE });
      }
    } finally {
      await dispatcher.close();
    }
  });
});

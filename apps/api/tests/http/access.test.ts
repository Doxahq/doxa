import { describe, expect, test } from "vitest";
import { getLocalDevUserId, getWebOrigin, isInternalHttpAllowed, isLocalOrigin } from "../../src/http/access";

describe("isLocalOrigin", () => {
  test.each([
    ["http://localhost:8787", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:8787", true],
    ["https://dev.doxa.so", false],
  ])("checks %s", (origin, expected) => {
    expect(isLocalOrigin(origin)).toBe(expected);
  });
});

describe("getLocalDevUserId", () => {
  test("accepts local dev header only from local origins", () => {
    expect(
      getLocalDevUserId(new Request("http://localhost:8787/projects", {
        headers: { "x-doxa-user-id": "local-dev-user" },
      }), { LOCAL_DEV_USER_ID: "local-dev-user" }),
    ).toBe("local-dev-user");

    expect(
      getLocalDevUserId(new Request("https://dev.doxa.so/projects", {
        headers: { "x-doxa-user-id": "local-dev-user" },
      }), { LOCAL_DEV_USER_ID: "local-dev-user" }),
    ).toBeNull();
  });

  test("accepts local install callbacks only from local origins", () => {
    expect(
      getLocalDevUserId(
        new Request("http://localhost:8787/github/install/callback?installation_id=local-dev"),
        { LOCAL_DEV_USER_ID: "local-dev-user" },
      ),
    ).toBe("local-dev-user");

    expect(
      getLocalDevUserId(
        new Request("https://dev.doxa.so/github/install/callback?installation_id=local-dev"),
        { LOCAL_DEV_USER_ID: "local-dev-user" },
      ),
    ).toBeNull();
  });
});

describe("getWebOrigin", () => {
  test("uses configured web origin for local callback redirects", () => {
    expect(
      getWebOrigin(new Request("http://localhost:8787/github/install/callback"), {
        WEB_ORIGIN: "https://dev.doxa.so/",
      }),
    ).toBe("https://dev.doxa.so");
  });

  test("uses configured web origin for production requests", () => {
    expect(
      getWebOrigin(new Request("https://api.doxa.so/github/install/callback"), {
        WEB_ORIGIN: "https://doxa.so",
      }),
    ).toBe("https://doxa.so");
  });

  test("uses request origin for tunneled requests when configured web origin is local", () => {
    expect(
      getWebOrigin(new Request("https://dev.doxa.so/github/install/callback"), {
        WEB_ORIGIN: "http://localhost:3001",
      }),
    ).toBe("https://dev.doxa.so");
  });
});

describe("isInternalHttpAllowed", () => {
  test("requires both explicit flag and local origin", () => {
    expect(
      isInternalHttpAllowed(new Request("http://localhost:8787/internal/docs-sites/demo"), {
        ALLOW_INTERNAL_HTTP: "true",
      }),
    ).toBe(true);
    expect(
      isInternalHttpAllowed(new Request("https://dev.doxa.so/internal/docs-sites/demo"), {
        ALLOW_INTERNAL_HTTP: "true",
      }),
    ).toBe(false);
    expect(
      isInternalHttpAllowed(new Request("http://localhost:8787/internal/docs-sites/demo"), {
        ALLOW_INTERNAL_HTTP: "false",
      }),
    ).toBe(false);
  });
});
